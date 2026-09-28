import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxMovements,
  boxes,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { batchLoadProgress } from '@/modules/wms/batches/card-head';
import { batchDocsPending } from '@/modules/wms/batches/docs-pending';
import { batchLots } from '@/modules/wms/batches/lots';
import { riderLoad } from '@/modules/wms/batches/riders';
import { vedFlowCounts } from '@/modules/wms/home/role-flows';
import { aboardFilter, batchMemberFilter, batchMissingBoxes, remainingToUnload } from '@/modules/wms/scanning/unload';
import { batchTnvedProducts, missingTnvedCount } from '@/modules/wms/tnved/batch-lots';
import { trucksOnRoad, truckOnRoadRow } from '@/modules/wms/tracking/on-road';

/**
 * The truck card (docs/CARD-TABS.md) against a real database: the header's
 * numbers are the tabs' own, and the reads rewritten on the way answer what
 * the old ones answered — or, where the old answer was the defect, the
 * better one, named.
 *
 * One truck carries every edge the membership rules disagree on: a carton
 * still aboard, one landed, one voided after departure, one found back at the
 * origin, one that rode with no load scan, one flagged missing, and a lot
 * whose every carton has already come off. A second, unloaded truck delivered
 * a carton that is now planned on a THIRD; a fourth is being loaded; a fifth
 * never crosses a border. Everything is deleted in the final test and the
 * warehouses DEACTIVATED, never deleted — an in-transit leftover is the next
 * spec's dashboard (#154).
 */

const SFX = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);

let actorId = '';
let whA = '';
let whB = '';
let whU2 = '';
let receiptId = '';
const lot: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' };
const truck: Record<string, string> = {};
const box: Record<number, string> = {};
const madeWarehouses: string[] = [];

async function mintWarehouse(code: string, country: 'CN' | 'UZ', type: string) {
  const [w] = await db
    .insert(warehouses)
    .values({
      code,
      name: `Card ${code}`,
      country,
      type,
      timezone: country === 'CN' ? 'Asia/Shanghai' : 'Asia/Tashkent',
      batchPrefix: code,
    })
    .returning({ id: warehouses.id });
  madeWarehouses.push(w!.id);
  return w!.id;
}

async function mintTruck(key: string, values: Partial<typeof batches.$inferInsert> & { status: string }) {
  const [b] = await db
    .insert(batches)
    .values({ code: `TC${key}-${SFX}`, originWarehouseId: whA, destWarehouseId: whB, createdBy: actorId, ...values })
    .returning({ id: batches.id });
  truck[key] = b!.id;
  return b!.id;
}

async function mintBox(
  n: number,
  lotKey: 'A' | 'B' | 'C',
  seq: number,
  state: Partial<typeof boxes.$inferInsert> & { status: string },
) {
  const [b] = await db
    .insert(boxes)
    .values({ lotId: lot[lotKey], seqInLot: seq, shortCode: `TC${SFX}${n}`, ...state })
    .returning({ id: boxes.id });
  box[n] = b!.id;
  return b!.id;
}

async function move(
  boxN: number,
  batchKey: string,
  cause: string,
  extra: Partial<typeof boxMovements.$inferInsert> = {},
) {
  await db.insert(boxMovements).values({
    boxId: box[boxN]!,
    fromStatus: 'loading',
    toStatus: 'in_transit',
    cause,
    refType: 'batch',
    refId: truck[batchKey]!,
    actorId,
    ...extra,
  });
}

/** The two filters as they were written before the round — the oracle the rewrite must match. */
const OLD_MEMBER = (id: string) => sql`(b.current_batch_id = ${id} OR EXISTS (
  SELECT 1 FROM box_movements bm WHERE bm.box_id = b.id
     AND bm.ref_type = 'batch' AND bm.ref_id = ${id} AND bm.cause = 'batch_departed'))`;
const OLD_ABOARD = (id: string) => sql`((b.current_batch_id = ${id} AND b.status <> 'planned') OR EXISTS (
  SELECT 1 FROM box_movements bm WHERE bm.box_id = b.id
     AND bm.ref_type = 'batch' AND bm.ref_id = ${id} AND bm.cause = 'batch_departed'))`;

async function oldIds(where: SQL): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`SELECT b.id FROM boxes b WHERE ${where} ORDER BY b.id`);
  return rows.map((r) => r.id);
}
async function newIds(where: SQL): Promise<string[]> {
  const rows = await db.select({ id: boxes.id }).from(boxes).where(where).orderBy(boxes.id);
  return rows.map((r) => r.id);
}
const ids = (...ns: number[]) => ns.map((n) => box[n]!).sort();

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  whA = await mintWarehouse(`ZTA${SFX.slice(0, 3)}`, 'CN', 'origin');
  whB = await mintWarehouse(`ZTB${SFX.slice(0, 3)}`, 'UZ', 'distribution');
  whU2 = await mintWarehouse(`ZTU${SFX.slice(0, 3)}`, 'UZ', 'distribution');

  receiptId = randomUUID();
  await db.insert(receipts).values({
    id: receiptId,
    number: `TC-${SFX}`,
    warehouseId: whA,
    status: 'confirmed',
    createdBy: actorId,
  });
  const lots = [
    { key: 'A' as const, seq: 1, letter: 'A', name: `甲${SFX}`, n: 7, kg: '70', m3: '0.7' },
    { key: 'B' as const, seq: 2, letter: 'B', name: `乙${SFX}`, n: 4, kg: '40', m3: '0.4' },
    { key: 'C' as const, seq: 3, letter: 'C', name: `丙${SFX}`, n: 2, kg: '20', m3: '0.2' },
  ];
  for (const l of lots) {
    const [row] = await db
      .insert(receiptLots)
      .values({
        receiptId,
        seq: l.seq,
        letter: l.letter,
        cycleNo: 1,
        productNameZh: l.name,
        boxCount: l.n,
        dimsMode: 'uniform',
        totalWeightKg: l.kg,
        totalVolumeM3: l.m3,
      })
      .returning({ id: receiptLots.id });
    lot[l.key] = row!.id;
  }

  // ROAD — arrived at the gate, mid-unload, papers not sent.
  await mintTruck('ROAD', { status: 'arrived', departedAt: ago(48), arrivedAt: ago(1) });
  await mintBox(1, 'A', 1, { status: 'ready_for_pickup', currentBatchId: null, currentWarehouseId: whB });
  await move(1, 'ROAD', 'batch_departed', { createdAt: ago(48) });
  await mintBox(2, 'A', 2, { status: 'in_transit', currentBatchId: truck.ROAD, currentWarehouseId: null });
  await move(2, 'ROAD', 'batch_departed', { createdAt: ago(48) });
  await mintBox(3, 'A', 3, { status: 'void', currentBatchId: truck.ROAD, currentWarehouseId: null });
  await move(3, 'ROAD', 'batch_departed', { createdAt: ago(48) });
  await mintBox(4, 'A', 4, { status: 'in_stock', currentBatchId: null, currentWarehouseId: whA });
  await move(4, 'ROAD', 'batch_departed', { createdAt: ago(48) });
  await db.insert(boxMovements).values({
    boxId: box[4]!,
    fromStatus: 'in_transit',
    toStatus: 'in_stock',
    toWarehouseId: whA,
    cause: 'found_at_origin',
    refType: 'batch',
    refId: truck.ROAD!,
    actorId,
    createdAt: ago(47),
  });
  // Rode with no load scan: landed at the destination as an undocumented transfer.
  await mintBox(5, 'B', 1, { status: 'ready_for_pickup', currentBatchId: null, currentWarehouseId: whB });
  await move(5, 'ROAD', 'undocumented_transfer', {
    fromStatus: 'in_stock',
    toStatus: 'ready_for_pickup',
    fromWarehouseId: whA,
    toWarehouseId: whB,
    createdAt: ago(1),
  });
  // Lot C's only carton here has already come off.
  await mintBox(6, 'C', 1, { status: 'ready_for_pickup', currentBatchId: null, currentWarehouseId: whB });
  await move(6, 'ROAD', 'batch_departed', { createdAt: ago(48) });
  // Flagged lost on the road, still pointing at the truck.
  await mintBox(10, 'A', 7, {
    status: 'in_transit',
    currentBatchId: truck.ROAD,
    currentWarehouseId: null,
    flags: ['missing_in_transit'],
  });
  await move(10, 'ROAD', 'batch_departed', { createdAt: ago(48) });

  // PREV delivered a carton that is now planned on NEXT.
  await mintTruck('NEXT', { status: 'forming', originWarehouseId: whB, destWarehouseId: whA });
  await mintTruck('PREV', { status: 'unloaded', departedAt: ago(100), arrivedAt: ago(90) });
  await mintBox(7, 'C', 2, { status: 'planned', currentBatchId: truck.NEXT, currentWarehouseId: whB });
  await move(7, 'PREV', 'batch_departed', { createdAt: ago(100) });

  // LOAD — being loaded: one reserved, one on it.
  await mintTruck('LOAD', { status: 'loading' });
  await mintBox(8, 'A', 5, { status: 'planned', currentBatchId: truck.LOAD, currentWarehouseId: whA });
  await mintBox(9, 'A', 6, { status: 'loading', currentBatchId: truck.LOAD, currentWarehouseId: whA });

  // LOCAL — Andijan → Tashkent shaped: no border, no papers.
  await mintTruck('LOCAL', { status: 'in_transit', originWarehouseId: whB, destWarehouseId: whU2, departedAt: ago(5) });
});

afterAll(async () => {
  await pgClient.end();
});

describe('the rewritten membership filters answer what the OR forms answered', () => {
  it('batchMemberFilter and aboardFilter, on every edge', async () => {
    for (const key of ['ROAD', 'PREV', 'NEXT', 'LOAD', 'LOCAL']) {
      const id = truck[key]!;
      expect(await newIds(batchMemberFilter(id)), `member ${key}`).toEqual(await oldIds(OLD_MEMBER(id)));
      expect(await newIds(aboardFilter(id)), `aboard ${key}`).toEqual(await oldIds(OLD_ABOARD(id)));
    }
    // …and the sets themselves, so the oracle cannot agree with itself about nothing.
    expect(await newIds(aboardFilter(truck.ROAD!))).toEqual(ids(1, 2, 3, 4, 6, 10));
    expect(await newIds(aboardFilter(truck.LOAD!))).toEqual(ids(9));
    expect(await newIds(batchMemberFilter(truck.LOAD!))).toEqual(ids(8, 9));
    expect(await newIds(aboardFilter(truck.NEXT!))).toEqual([]);
  });
});

describe('the header’s «Yuk» is the cost tab’s divisor', () => {
  it('Σ of the contents rows equals riderLoad — the old card counted two cartons that never rode and missed one that did', async () => {
    const lots = await batchLots(truck.ROAD!);
    const load = (await riderLoad([truck.ROAD!])).get(truck.ROAD!)!;
    const boxesOn = lots.reduce((a, l) => a + l.onBatch, 0);
    // Riders: landed, aboard, the unscanned one, lot C's and the missing one;
    // never the voided carton or the one found back at the origin.
    expect(boxesOn).toBe(5);
    expect(Number(load.boxCount)).toBe(boxesOn);
    expect(lots.reduce((a, l) => a + l.kg, 0)).toBeCloseTo(load.kg, 1);
    expect(lots.reduce((a, l) => a + l.m3, 0)).toBeCloseTo(load.m3, 2);
    // The card's old membership (the manifest's): six — the voided carton and
    // the one found back at the origin in, the one that rode unscanned out.
    expect(await newIds(batchMemberFilter(truck.ROAD!))).toEqual(ids(1, 2, 3, 4, 6, 10));
  });
});

describe('the loaded line reads the live pointer only', () => {
  it('a truck being loaded: one reserved, one on', async () => {
    const progress = await batchLoadProgress(truck.LOAD!);
    expect(progress.get(lot.A)).toEqual({ planned: 1, loaded: 1, qrless: 0 });
  });

  it('a carton the unloaded truck delivered, now planned on the NEXT one, is not «planned» here', async () => {
    const progress = await batchLoadProgress(truck.PREV!);
    expect(progress.get(lot.C)).toEqual({ planned: 0, loaded: 0, qrless: 0 });
  });
});

describe('the TNVED list after departure', () => {
  it('keeps a lot whose every carton has come off — the VED declares mid-unload', async () => {
    const products = await batchTnvedProducts(truck.ROAD!, true);
    // Lot A (still partly aboard) AND lot C (all landed); lot B only rode
    // unscanned — no load scan, no departure — so it was never on the
    // truck's papers.
    expect(products.map((p) => p.nameZh).sort()).toEqual([`丙${SFX}`, `甲${SFX}`].sort());
    expect(missingTnvedCount(products)).toBe(2);
  });

  it('before departure it is the live pointer, the plan included', async () => {
    const products = await batchTnvedProducts(truck.LOAD!, false);
    expect(products.map((p) => p.nameZh)).toEqual([`甲${SFX}`]);
    expect(products[0]!.boxCount).toBe(7);
  });
});

describe('«Agentga yuborilmagan» is the VED home’s own sentence, asked of one truck', () => {
  it('pending on a truck across a border, not on one inside a country, gone once sent', async () => {
    const before = (await vedFlowCounts()).docsPending;
    expect(await batchDocsPending(truck.ROAD!)).toBe(true);
    expect(await batchDocsPending(truck.LOCAL!)).toBe(false);
    expect(await batchDocsPending(truck.LOAD!)).toBe(false);
    await db.update(batches).set({ sentToAgentAt: '2026-09-27' }).where(eq(batches.id, truck.ROAD!));
    expect(await batchDocsPending(truck.ROAD!)).toBe(false);
    // The home's company-wide count moved by exactly this truck.
    expect((await vedFlowCounts()).docsPending).toBe(before - 1);
    await db.update(batches).set({ sentToAgentAt: null }).where(eq(batches.id, truck.ROAD!));
  });
});

describe('the header’s road sentence is the dashboard’s row for the same truck', () => {
  it('truckOnRoadRow equals trucksOnRoad’s row', async () => {
    const one = await truckOnRoadRow(truck.ROAD!);
    const board = await trucksOnRoad([whA], { limit: 50 });
    const same = board.rows.find((row) => row.id === truck.ROAD);
    expect(one).not.toBeNull();
    expect(same).toBeDefined();
    const pick = (r: typeof one) => ({
      kind: r!.kind,
      status: r!.status,
      days: r!.days,
      departedBoxes: r!.departedBoxes,
      awaitingUnload: r!.awaitingUnload,
      eta: r!.eta,
    });
    expect(pick(one)).toEqual(pick(same!));
    // Departed and not void: the voided carton and the unscanned one are out.
    expect(one!.departedBoxes).toBe(5);
    // What the unload screen counts down — the header's «Qabul qilinmagan».
    expect(one!.awaitingUnload).toBe((await remainingToUnload(truck.ROAD!)).length);
    // Not on the road any more: no sentence at all, never «overdue».
    expect(await truckOnRoadRow(truck.PREV!)).toBeNull();
  });

  it('the missing list the header counts is the unloading tab’s', async () => {
    const missing = await batchMissingBoxes(truck.ROAD!);
    expect(missing.map((m) => m.box.id)).toEqual([box[10]]);
  });
});

describe('cleanup', () => {
  it('leaves no truck, carton or prixod of this file behind', async () => {
    const boxIds = Object.values(box);
    const truckIds = Object.values(truck);
    await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
    await db.delete(boxes).where(inArray(boxes.id, boxIds));
    await db.delete(receiptLots).where(eq(receiptLots.receiptId, receiptId));
    await db.delete(receipts).where(eq(receipts.id, receiptId));
    await db.delete(batches).where(inArray(batches.id, truckIds));
    await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, madeWarehouses));
    expect(await db.select({ id: batches.id }).from(batches).where(inArray(batches.id, truckIds))).toEqual([]);
  });
});
