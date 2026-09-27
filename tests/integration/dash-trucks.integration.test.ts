import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxMovements,
  boxes,
  driverPositions,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { awaitingUnloadCounts, remainingToUnload } from '@/modules/wms/scanning/unload';
import { etaWindow, scheduleEstimate } from '@/modules/wms/tracking/eta';
import { trucksOnRoad } from '@/modules/wms/tracking/on-road';

/**
 * The dashboard's trucks card against a real database (round B).
 *
 * What only a database can say: that a voided carton is out of «jo'nagan»,
 * that «N karobka tushirilmagan» is the unload screen's own number, that a
 * truck belongs to both of its ends and to nobody else, that nothing still
 * being loaded or already closed rides the list — and that a scoped viewer
 * with NO warehouse sees no truck at all, because the report underneath
 * reads an empty list as «the whole company».
 *
 * The minted warehouses carry codes the route table has never heard of, so
 * their trucks are honestly «no schedule»; the one schedule assertion rides
 * the seeded YW → TAS1 pair. Every truck here is deleted in the final test —
 * an in-transit leftover is the next spec's map and dashboard (#154) — and
 * the warehouses are DEACTIVATED, never deleted.
 */

const SFX = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const NOW = new Date();
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

let actorId = '';
let whA = '';
let whB = '';
let whC = '';
let whYW = '';
let receiptId = '';
let lotId = '';
const batchIds: Record<string, string> = {};
const boxIds: string[] = [];
const madeWarehouses: string[] = [];
let positionAt: Date;

async function mintWarehouse(code: string, country: 'CN' | 'UZ', type: string) {
  const [w] = await db
    .insert(warehouses)
    .values({
      code,
      name: `Dash ${code}`,
      country,
      type,
      timezone: country === 'CN' ? 'Asia/Shanghai' : 'Asia/Tashkent',
      batchPrefix: code,
    })
    .returning({ id: warehouses.id });
  madeWarehouses.push(w!.id);
  return w!.id;
}

async function mintBatch(
  key: string,
  values: Partial<typeof batches.$inferInsert> & { status: string },
) {
  const [b] = await db
    .insert(batches)
    .values({
      code: `DT${key}-${SFX}`,
      originWarehouseId: whA,
      destWarehouseId: whB,
      createdBy: actorId,
      ...values,
    })
    .returning({ id: batches.id });
  batchIds[key] = b!.id;
  return b!.id;
}

/** A carton that DEPARTED on `batchId`, standing wherever `state` says now. */
async function departedBox(
  batchId: string,
  seq: number,
  state: { status: string; currentBatchId: string | null; currentWarehouseId: string | null },
) {
  const [box] = await db
    .insert(boxes)
    .values({ lotId, seqInLot: seq, shortCode: `DT${SFX}${seq}`, ...state })
    .returning({ id: boxes.id });
  boxIds.push(box!.id);
  await db.insert(boxMovements).values({
    boxId: box!.id,
    fromStatus: 'loading',
    toStatus: 'in_transit',
    cause: 'batch_departed',
    refType: 'batch',
    refId: batchId,
    actorId,
  });
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  whA = await mintWarehouse(`ZDA${SFX.slice(0, 3)}`, 'CN', 'origin');
  whB = await mintWarehouse(`ZDB${SFX.slice(0, 3)}`, 'UZ', 'distribution');
  whC = await mintWarehouse(`ZDC${SFX.slice(0, 3)}`, 'CN', 'origin');
  whYW = (await db.query.warehouses.findFirst({ where: eq(warehouses.code, 'YW') }))!.id;
  const whTAS = (await db.query.warehouses.findFirst({ where: eq(warehouses.code, 'TAS1') }))!.id;

  receiptId = randomUUID();
  await db.insert(receipts).values({
    id: receiptId,
    number: `DT-${SFX}`,
    warehouseId: whA,
    status: 'confirmed',
    createdBy: actorId,
  });
  const [lot] = await db
    .insert(receiptLots)
    .values({
      receiptId,
      seq: 1,
      letter: 'A',
      cycleNo: 1,
      productNameZh: '测试',
      boxCount: 6,
      dimsMode: 'uniform',
      totalWeightKg: '60',
      totalVolumeM3: '0.6',
    })
    .returning({ id: receiptLots.id });
  lotId = lot!.id;

  // On the road: two cartons aboard and one that departed and was VOIDED.
  const road = await mintBatch('ROAD', { status: 'in_transit', departedAt: ago(24) });
  await departedBox(road, 1, { status: 'in_transit', currentBatchId: road, currentWarehouseId: null });
  await departedBox(road, 2, { status: 'void', currentBatchId: road, currentWarehouseId: null });
  await departedBox(road, 3, { status: 'in_transit', currentBatchId: road, currentWarehouseId: null });

  // At the gate: one carton scanned off (its pointer is gone — that is what
  // landing does), two still aboard.
  const gate = await mintBatch('GATE', { status: 'arrived', departedAt: ago(200), arrivedAt: ago(1) });
  await departedBox(gate, 4, { status: 'ready_for_pickup', currentBatchId: null, currentWarehouseId: whB });
  await departedBox(gate, 5, { status: 'in_transit', currentBatchId: gate, currentWarehouseId: null });
  await departedBox(gate, 6, { status: 'in_transit', currentBatchId: gate, currentWarehouseId: null });

  // Being loaded — counted, never listed.
  await mintBatch('LOAD', { status: 'loading' });
  await mintBatch('FORM', { status: 'forming' });
  // Finished or never happened — neither listed nor counted.
  await mintBatch('DONE', { status: 'closed', departedAt: ago(500), arrivedAt: ago(300) });
  await mintBatch('UNLD', { status: 'unloaded', departedAt: ago(500), arrivedAt: ago(300) });
  await mintBatch('CANC', { status: 'cancelled' });

  // A seeded pair the route table knows — the one schedule assertion.
  await mintBatch('YWTAS', {
    status: 'in_transit',
    originWarehouseId: whYW,
    destWarehouseId: whTAS,
    departedAt: ago(72),
  });

  positionAt = ago(2);
  await db.insert(driverPositions).values({
    batchId: road,
    lat: '40.100000',
    lon: '72.500000',
    recordedAt: positionAt,
    source: 'manual',
    createdBy: actorId,
  });
});

afterAll(async () => {
  await pgClient.end();
});

describe('trucksOnRoad — the in-transit report, classified', () => {
  it('lists what is on the road or at the gate, and nothing being loaded or finished', async () => {
    const out = await trucksOnRoad([whA], { limit: 50, now: NOW });
    expect(out.rows.map((r) => r.id).sort()).toEqual([batchIds.ROAD!, batchIds.GATE!].sort());
    expect(out.total).toBe(2);
    // Unmapped codes: honestly no schedule. The gate truck arrived an hour ago.
    expect(out.counts).toEqual({ stuck: 0, overdue: 0, unloading: 1, on_road: 0, no_schedule: 1 });
    // forming + loading, counted and never drawn as a row.
    expect(out.loading).toBe(2);
  });

  it('a voided carton is not «jo’nagan»', async () => {
    const out = await trucksOnRoad([whA], { limit: 50, now: NOW });
    const road = out.rows.find((r) => r.id === batchIds.ROAD)!;
    // Three departed, one of them voided.
    expect(road.departedBoxes).toBe(2);
    expect(road.awaitingUnload).toBeNull();
  });

  it('«tushirilmagan» is the unload screen’s own number', async () => {
    const out = await trucksOnRoad([whA], { limit: 50, now: NOW });
    const gate = out.rows.find((r) => r.id === batchIds.GATE)!;
    const remaining = await remainingToUnload(batchIds.GATE!);
    expect(remaining).toHaveLength(2);
    expect(gate.awaitingUnload).toBe(remaining.length);
    // The grouped count agrees with the per-truck list — and a voided carton
    // still pointing at its truck is not waiting to be unloaded.
    const counts = await awaitingUnloadCounts([batchIds.GATE!, batchIds.ROAD!]);
    expect(counts.get(batchIds.GATE!)).toBe(2);
    expect(counts.get(batchIds.ROAD!)).toBe((await remainingToUnload(batchIds.ROAD!)).length);
    expect(counts.get(batchIds.ROAD!)).toBe(2);
    expect(await awaitingUnloadCounts([])).toEqual(new Map());
  });

  it('carries the driver’s newest position, apart from the schedule', async () => {
    const out = await trucksOnRoad([whA], { limit: 50, now: NOW });
    const road = out.rows.find((r) => r.id === batchIds.ROAD)!;
    expect(road.lastPositionAt?.getTime()).toBe(positionAt.getTime());
    expect(road.kind).toBe('no_schedule');
  });

  it('a truck belongs to both of its ends and to nobody else', async () => {
    const dest = await trucksOnRoad([whB], { limit: 50, now: NOW });
    expect(dest.rows.map((r) => r.id)).toEqual(
      expect.arrayContaining([batchIds.ROAD!, batchIds.GATE!]),
    );
    const third = await trucksOnRoad([whC], { limit: 50, now: NOW });
    expect(third.total).toBe(0);
    expect(third.rows).toEqual([]);
    expect(third.loading).toBe(0);
  });

  it('counts cover every truck; only the slice is enriched', async () => {
    const out = await trucksOnRoad([whA], { limit: 1, now: NOW });
    expect(out.total).toBe(2);
    expect(out.rows).toHaveLength(1);
    // The gate truck ranks above the unplaceable one, and it was enriched.
    expect(out.rows[0]!.id).toBe(batchIds.GATE);
    expect(out.rows[0]!.awaitingUnload).toBe(2);
  });

  it('a scoped viewer with NO warehouse sees no truck at all', async () => {
    // inTransitBatches reads [] as «no filter» — the whole company.
    const empty = await trucksOnRoad([], { limit: 50, now: NOW });
    expect(empty).toEqual({
      rows: [],
      total: 0,
      counts: { stuck: 0, overdue: 0, unloading: 0, on_road: 0, no_schedule: 0 },
      loading: 0,
    });
    // The dashboard's own spelling of «no warehouse» today (scopeKeyOf).
    const nil = await trucksOnRoad(['00000000-0000-0000-0000-000000000000'], { limit: 50, now: NOW });
    expect(nil.total).toBe(0);
    expect(nil.loading).toBe(0);
  });

  it('a seeded YW → TAS1 truck gets the cabinet’s own window', async () => {
    const out = await trucksOnRoad([whYW], { limit: 1000, now: NOW });
    const row = out.rows.find((r) => r.id === batchIds.YWTAS)!;
    const s = scheduleEstimate('YW', 'TAS1', ago(72), null, NOW)!;
    expect(row.kind).toBe('on_road');
    expect(row.stage).toBe('export_transit');
    expect(row.roadPct).toBe(Math.round(s.est.progress * 100));
    expect(row.eta).toEqual(etaWindow(s.est, NOW));
  });

  it('cleans up: no truck of this file is left on anybody’s road', async () => {
    const ids = Object.values(batchIds);
    await db.delete(driverPositions).where(inArray(driverPositions.batchId, ids));
    await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
    await db.delete(boxes).where(inArray(boxes.id, boxIds));
    await db.delete(receiptLots).where(eq(receiptLots.id, lotId));
    await db.delete(receipts).where(eq(receipts.id, receiptId));
    await db.delete(batches).where(inArray(batches.id, ids));
    await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, madeWarehouses));
    const left = await db.select({ id: batches.id }).from(batches).where(inArray(batches.id, ids));
    expect(left).toEqual([]);
    const still = await db
      .select({ active: warehouses.active })
      .from(warehouses)
      .where(inArray(warehouses.id, madeWarehouses));
    expect(still.every((w) => w.active === false)).toBe(true);
  });
});
