import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxMovements,
  boxes,
  factories,
  pickupLines,
  pickups,
  pickupStops,
  receiptLots,
  receipts,
  scanEvents,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { loadBoard, type BoardActor, type BoardTrip, type BoardTruck } from '@/modules/wms/batches/board';
import { assembleBoard } from '@/modules/wms/batches/board-view';

/**
 * The batch board's reader against a real database (docs/PARTIYA-DOSKASI.md
 * §3-§4): the first and last carton of the CURRENT cargo, the loaded / planned
 * figures, the pins, who sees which truck, and which factory trips a viewer
 * is shown. Everything is deleted in the final test and the warehouses
 * DEACTIVATED, never deleted — an open truck left behind is the next spec's
 * board (#154).
 */

const SFX = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const HOUR = 3_600_000;
const NOW = Date.now();
const at = (hours: number) => new Date(NOW + hours * HOUR);

let actorId = '';
let whO = '';
let whD = '';
let whX = '';
let whY = '';
let receiptId = '';
let lotId = '';
const truck: Record<string, string> = {};
const box: Record<number, string> = {};
const trip: Record<string, string> = {};
let factoryId = '';
const madeWarehouses: string[] = [];

async function mintWarehouse(code: string, country: 'CN' | 'UZ', type: string) {
  const [w] = await db
    .insert(warehouses)
    .values({
      code,
      name: `Board ${code}`,
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
    .values({ code: `BB${key}-${SFX}`, originWarehouseId: whO, destWarehouseId: whD, createdBy: actorId, ...values })
    .returning({ id: batches.id });
  truck[key] = b!.id;
}

async function mintBox(n: number, state: Partial<typeof boxes.$inferInsert> & { status: string }) {
  const [b] = await db
    .insert(boxes)
    .values({ lotId, seqInLot: n, shortCode: `BB${SFX}${n}`, ...state })
    .returning({ id: boxes.id });
  box[n] = b!.id;
}

/** A load scan as the phone sent it: its own clock, and when the server took it. */
async function loadScan(n: number, key: string, scannedAt: Date, createdAt: Date) {
  await db.insert(scanEvents).values({
    clientEventUuid: randomUUID(),
    boxId: box[n]!,
    batchId: truck[key]!,
    type: 'load',
    method: 'qr',
    scannedBy: actorId,
    scannedAt,
    createdAt,
  });
}

async function mintTrip(
  key: string,
  values: Partial<typeof pickups.$inferInsert> & { status: string; destWarehouseId: string },
  lines: { factoryBoxes: number; driverBoxes?: number; volumeM3?: string; weightKg?: string }[],
  collectedAt: Date | null,
) {
  const [p] = await db
    .insert(pickups)
    .values({ code: `ZB${key}-${SFX}`, createdBy: actorId, ...values })
    .returning({ id: pickups.id });
  trip[key] = p!.id;
  const [stop] = await db
    .insert(pickupStops)
    .values({ pickupId: p!.id, seq: 1, factoryId, collectedAt })
    .returning({ id: pickupStops.id });
  for (const line of lines) {
    await db.insert(pickupLines).values({ stopId: stop!.id, marking: `M${SFX}`, goods: 'test', ...line });
  }
}

const unscoped = (codes: string[]): BoardActor => ({
  permissions: new Set(codes),
  warehouseScoped: false,
  warehouseIds: [],
});

const mine = <T extends { id: string }>(cards: T[], ids: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(ids).map(([key, id]) => [key, cards.find((c) => c.id === id)]),
  ) as Record<string, T | undefined>;

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  whO = await mintWarehouse(`ZBO${SFX.slice(0, 3)}`, 'CN', 'origin');
  whD = await mintWarehouse(`ZBD${SFX.slice(0, 3)}`, 'UZ', 'distribution');
  whX = await mintWarehouse(`ZBX${SFX.slice(0, 3)}`, 'UZ', 'distribution');
  whY = await mintWarehouse(`ZBY${SFX.slice(0, 3)}`, 'UZ', 'distribution');

  receiptId = randomUUID();
  await db.insert(receipts).values({ id: receiptId, number: `BB-${SFX}`, warehouseId: whO, status: 'confirmed', createdBy: actorId });
  const [lot] = await db
    .insert(receiptLots)
    .values({
      receiptId,
      seq: 1,
      letter: 'A',
      cycleNo: 1,
      productNameZh: `板${SFX}`,
      boxCount: 10,
      dimsMode: 'uniform',
      totalWeightKg: '100',
      totalVolumeM3: '1',
    })
    .returning({ id: receiptLots.id });
  lotId = lot!.id;

  // LOAD — being loaded since ten days ago.
  await mintTruck('LOAD', { status: 'loading', createdAt: at(-240) });
  await mintBox(1, { status: 'loading', currentBatchId: truck.LOAD, currentWarehouseId: whO });
  // Scanned twice — off and on again: the LATER scan dates it.
  await loadScan(1, 'LOAD', at(-200), at(-200));
  await loadScan(1, 'LOAD', at(-100), at(-100));
  await mintBox(2, { status: 'loading', currentBatchId: truck.LOAD, currentWarehouseId: whO });
  // The phone's clock runs a day fast: the server's time is the earlier one.
  await loadScan(2, 'LOAD', at(-26), at(-50));
  // Only reserved — a scan made and taken back is not cargo.
  await mintBox(3, { status: 'planned', currentBatchId: truck.LOAD, currentWarehouseId: whO });
  await loadScan(3, 'LOAD', at(-230), at(-230));
  // Scanned by mistake and taken off: back on the shelf, no ride.
  await mintBox(4, { status: 'in_stock', currentBatchId: null, currentWarehouseId: whO });
  await loadScan(4, 'LOAD', at(-235), at(-235));

  // ROAD — departed two days ago, pinned in Uzbekistan.
  await mintTruck('ROAD', {
    status: 'in_transit',
    createdAt: at(-120),
    departedAt: at(-48),
    trackingCheckpoint: { key: 'in_uz', at: at(-10).toISOString() },
    driverPhone: '+998 90 111 22 33',
  });
  await mintBox(5, { status: 'in_transit', currentBatchId: truck.ROAD, currentWarehouseId: null });
  await db.insert(boxMovements).values({
    boxId: box[5]!,
    fromStatus: 'loading',
    toStatus: 'in_transit',
    cause: 'batch_departed',
    refType: 'batch',
    refId: truck.ROAD!,
    actorId,
    createdAt: at(-48),
  });
  // A phone set a year wrong: kept to the truck's own days.
  await loadScan(5, 'ROAD', at(-24 * 365), at(-24 * 365));
  await mintBox(6, { status: 'in_transit', currentBatchId: truck.ROAD, currentWarehouseId: null });
  await loadScan(6, 'ROAD', at(-1), at(-1));

  // FAR — a truck between two Uzbek warehouses, nothing to do with whO.
  await mintTruck('FAR', { status: 'forming', originWarehouseId: whX, destWarehouseId: whY });

  const [f] = await db.insert(factories).values({ name: `Board factory ${SFX}`, createdBy: actorId }).returning({ id: factories.id });
  factoryId = f!.id;
  await mintTrip(
    'GO',
    { status: 'on_road', destWarehouseId: whD, startedAt: at(-5) },
    [
      { factoryBoxes: 10, driverBoxes: 12, volumeM3: '1.5' },
      { factoryBoxes: 5, weightKg: '100' },
    ],
    at(-5),
  );
  await mintTrip('OLD', { status: 'arrived', destWarehouseId: whD, arrivedAt: at(-24 * 20) }, [{ factoryBoxes: 1 }], at(-24 * 21));
  await mintTrip('NEXT', { status: 'planned', destWarehouseId: whX, plannedOn: '2026-11-01' }, [{ factoryBoxes: 3 }], null);
});

afterAll(async () => {
  await pgClient.end();
});

describe('the truck cards', () => {
  it('first and last carton of the CURRENT cargo, by the server’s clock, inside the truck’s own days', async () => {
    const board = await loadBoard(unscoped(['plans.manage']));
    const t = mine(board.cards.filter((c): c is BoardTruck => c.type === 'batch'), truck);
    // Box 1's later scan, box 2's server time; the planned and the taken-off
    // cartons date nothing.
    expect(t.LOAD!.loadFrom).toBe(at(-100).toISOString());
    expect(t.LOAD!.loadTo).toBe(at(-50).toISOString());
    // A year-early phone reads as the truck's creation, a scan after
    // departure as the departure.
    expect(t.ROAD!.loadFrom).toBe(at(-120).toISOString());
    expect(t.ROAD!.loadTo).toBe(at(-48).toISOString());
    expect(t.FAR!.loadFrom).toBeNull();
  });

  it('loaded over planned on the loading truck; what rode on the departed one', async () => {
    const board = await loadBoard(unscoped(['plans.manage']));
    const t = mine(board.cards.filter((c): c is BoardTruck => c.type === 'batch'), truck);
    expect(t.LOAD!.load).toEqual({
      loaded: { boxes: 2, kg: 20, m3: 0.2 },
      planned: { boxes: 3, kg: 30, m3: 0.3 },
    });
    expect(t.LOAD!.column).toBe('loading');
    expect(t.LOAD!.section).toBe('cn');
    expect(t.ROAD!.load).toBeNull();
    expect(t.ROAD!.rode).toMatchObject({ boxes: 2, kg: 20, m3: 0.2 });
    expect(t.ROAD!.road?.status).toBe('in_transit');
    expect(t.ROAD!.departedAt).toBe(at(-48).toISOString());
    expect(t.FAR!.internal).toBe(true);
    expect(t.LOAD!.internal).toBe(false);
  });

  it('the pins only for a vehicle_info holder on the road, the standing pin a chip and never a button', async () => {
    const pinner = mine(
      (await loadBoard(unscoped(['plans.manage', 'batches.vehicle_info']))).cards.filter(
        (c): c is BoardTruck => c.type === 'batch',
      ),
      truck,
    );
    expect(pinner.ROAD!.pins).toEqual({ current: 'in_uz', options: [] });
    expect(pinner.LOAD!.pins).toBeNull();
    const other = mine(
      (await loadBoard(unscoped(['plans.manage']))).cards.filter((c): c is BoardTruck => c.type === 'batch'),
      truck,
    );
    expect(other.ROAD!.pins).toBeNull();
    expect(other.ROAD!.driverPhone).toBe('+998 90 111 22 33');
  });

  it('a warehouse-scoped viewer sees the trucks at either of their ends and no other', async () => {
    const board = await loadBoard({ permissions: new Set(['scan.load']), warehouseScoped: true, warehouseIds: [whO] });
    const ids = new Set(board.cards.map((c) => c.id));
    expect(ids.has(truck.LOAD!)).toBe(true);
    expect(ids.has(truck.ROAD!)).toBe(true);
    expect(ids.has(truck.FAR!)).toBe(false);
    // No trip door for a loader.
    expect(board.cards.some((c) => c.type === 'trip')).toBe(false);
    const nothing = await loadBoard({ permissions: new Set(['scan.load']), warehouseScoped: true, warehouseIds: [] });
    expect(nothing.cards).toEqual([]);
  });
});

describe('the factory trips (9b)', () => {
  it('the logist reads every open trip — the driver’s recount over the factory’s, unknowns counted', async () => {
    const board = await loadBoard(unscoped(['plans.manage']));
    const p = mine(board.cards.filter((c): c is BoardTrip => c.type === 'trip'), trip);
    expect(p.GO).toMatchObject({
      column: 'road',
      section: 'uz',
      boxes: 17,
      m3: 1.5,
      m3Missing: 1,
      kg: 100,
      kgMissing: 1,
      lines: 2,
      stops: 1,
      collected: 1,
      warnings: [],
    });
    expect(p.OLD).toMatchObject({ column: 'arrived', warnings: ['stale'] });
    expect(p.NEXT).toMatchObject({ column: 'forming', section: 'uz', plannedOn: '2026-11-01' });
  });

  it('a receiver reads only the trips coming to their warehouse, and not the stale ones', async () => {
    const board = await loadBoard({
      permissions: new Set(['receipts.create']),
      warehouseScoped: true,
      warehouseIds: [whD],
    });
    const ids = new Set(board.cards.filter((c) => c.type === 'trip').map((c) => c.id));
    expect(ids.has(trip.GO!)).toBe(true);
    expect(ids.has(trip.OLD!)).toBe(false);
    expect(ids.has(trip.NEXT!)).toBe(false);
  });

  it('`?sklad=` keeps a truck by either end and a trip by its destination', async () => {
    const board = await loadBoard(unscoped(['plans.manage']));
    const view = assembleBoard(board.cards, { sklad: whX, yonalish: null, ogoh: false, joy: null });
    const shown = view.columns.flatMap((c) => c.sections.flatMap((s) => s.cards.map((card) => card.id)));
    expect(shown).toContain(truck.FAR);
    expect(shown).toContain(trip.NEXT);
    expect(shown).not.toContain(truck.LOAD);
    expect(shown).not.toContain(trip.GO);
  });
});

describe('cleanup', () => {
  it('leaves no truck, carton, trip or prixod of this file behind', async () => {
    const boxIds = Object.values(box);
    const truckIds = Object.values(truck);
    await db.delete(scanEvents).where(inArray(scanEvents.boxId, boxIds));
    await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
    await db.delete(boxes).where(inArray(boxes.id, boxIds));
    await db.delete(receiptLots).where(eq(receiptLots.receiptId, receiptId));
    await db.delete(receipts).where(eq(receipts.id, receiptId));
    await db.delete(batches).where(inArray(batches.id, truckIds));
    await db.delete(pickups).where(inArray(pickups.id, Object.values(trip)));
    await db.delete(factories).where(eq(factories.id, factoryId));
    await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, madeWarehouses));
    expect(await db.select({ id: batches.id }).from(batches).where(inArray(batches.id, truckIds))).toEqual([]);
    expect(await db.select({ id: pickups.id }).from(pickups).where(inArray(pickups.id, Object.values(trip)))).toEqual([]);
  });
});
