import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { attachments, batches, boxes, clients, driverPositions, users, warehouses } from '@/modules/platform/db/schema';
import { confirmReceipt, voidReceipt } from '@/modules/wms/receipts/service';
import { cargoOverview } from '@/modules/wms/client-cabinet/service';
import { cabinetMap } from '@/modules/wms/client-cabinet/map';
import { latestPositions } from '@/modules/wms/tracking/devices';
import { cumulativeLengths } from '@/modules/wms/tracking/engine';
import { routeFor, WAREHOUSE_POINTS } from '@/modules/wms/tracking/map-data';
import { trucksOnRoadRows } from '@/modules/wms/tracking/on-road';
import { loadBoard, type BoardTruck } from '@/modules/wms/batches/board';
import { truckFor } from '@/modules/wms/tracking/truck';

/**
 * The readers of a truck's place (docs/PARTIYA-DOSKASI.md §2), each proven
 * on what it hands a PERSON — the board's review found every one of these
 * guarded by a test that could not fail:
 *
 * - the map and the bot (`truckFor`): a stale fix after the departure
 *   anchors the walk; a truck pinned in Uzbekistan carries no date (O15); an
 *   ARRIVED truck stands at its gate with no date; a truck nothing honest
 *   places is not drawn on its destination warehouse;
 * - the evidence (`latestPositions`): a phone's clock running ahead never
 *   makes a fix newer than its arrival, and a coarse cell-tower fix is not
 *   a position;
 * - the customer (`cargoOverview`, `cabinetMap`): an arrived China-bound
 *   truck has no % and no date, and the cabinet's % follows the driver's
 *   phone exactly as the office's does.
 */

const HOUR = 3_600_000;
const STAMP = String(Date.now()).slice(-7);
let actorId = '';
let ids: Record<'YW' | 'KA' | 'TAS1', string>;
let truckRow: typeof batches.$inferSelect;
let clientId = '';
let receiptId = '';
let lotId = '';
const made: string[] = [];

const ends = (o: 'YW' | 'KA', d: 'KA' | 'TAS1', dc = d === 'KA' ? 'CN' : 'UZ') => ({
  originCode: o,
  destCode: d,
  originCountry: 'CN',
  destCountry: dc,
});

async function mintBatch(o: 'YW' | 'KA', d: 'KA' | 'TAS1', over: Partial<typeof batches.$inferInsert>) {
  const [b] = await db
    .insert(batches)
    .values({
      code: `BRD-${STAMP}-${made.length}`,
      originWarehouseId: ids[o],
      destWarehouseId: ids[d],
      status: 'in_transit',
      departedAt: new Date(Date.now() - 24 * HOUR),
      createdBy: actorId,
      ...over,
    })
    .returning();
  made.push(b!.id);
  return b!;
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  const rows = await db.select({ id: warehouses.id, code: warehouses.code }).from(warehouses);
  const byCode = new Map(rows.map((r) => [r.code, r.id]));
  ids = { YW: byCode.get('YW')!, KA: byCode.get('KA')!, TAS1: byCode.get('TAS1')! };
  truckRow = await mintBatch('KA', 'TAS1', {});

  const [c] = await db
    .insert(clients)
    .values({ clientCode: `BR${STAMP.slice(-6)}`, name: 'Board readers client' })
    .returning();
  clientId = c!.id;
  receiptId = uuidv4();
  lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `brtest/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId: ids.YW,
      clientId,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '样品',
          boxCount: 2,
          dimsMode: 'uniform',
          boxLengthCm: 30,
          boxWidthCm: 30,
          boxHeightCm: 30,
          boxWeightKg: 5,
        },
      ],
      extraCosts: [],
    },
    { actorId },
  );
});

afterAll(async () => {
  // Nothing here may outlive the file: the boxes stood in the SEEDED Yiwu
  // warehouse and the trucks are in_transit, which every later board,
  // dashboard and map reads (#154).
  await db
    .update(boxes)
    .set({ status: 'in_stock', currentBatchId: null, currentWarehouseId: ids.YW })
    .where(eq(boxes.lotId, lotId));
  try {
    // A refused void must fail LOUDLY: swallowed, it would leave two
    // confirmed cartons on the seeded Yiwu shelf for every later spec.
    await voidReceipt(receiptId, 'board readers test cleanup', { actorId });
    const left = await db.select({ status: boxes.status }).from(boxes).where(eq(boxes.lotId, lotId));
    if (left.some((b) => b.status !== 'void')) throw new Error('board-readers: the receipt voided but its cartons did not');
  } finally {
    for (const id of made) {
      await db.delete(driverPositions).where(eq(driverPositions.batchId, id));
      await db.execute(sql`DELETE FROM box_movements WHERE ref_type = 'batch' AND ref_id = ${id}`);
      await db.delete(batches).where(eq(batches.id, id));
    }
    await db.delete(attachments).where(eq(attachments.entityId, lotId));
    await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
    await pgClient.end();
  }
});

describe('the map and the bot read the one placement', () => {
  it('a stale fix AFTER the departure anchors the walk — never the departure schedule', async () => {
    const route = routeFor('KA', 'TAS1')!;
    const cum = cumulativeLengths(route.points);
    const total = cum[cum.length - 1]!;
    const row = { ...truckRow, departedAt: new Date(Date.now() - 40 * HOUR) };
    const bare = (await truckFor(row, ends('KA', 'TAS1'), {}))!;
    // A point well ahead of where the schedule alone puts the truck, on the
    // Kyrgyz leg (a moving leg, away from any post).
    const kg = route.segments.find((s) => s.key === 'kg')!;
    const at = kg.span[1] - 2;
    expect(cum[at]! / total).toBeGreaterThan(bare.progress! + 0.05);
    const fixAt = new Date(Date.now() - 20 * HOUR);
    const marker = (await truckFor(row, ends('KA', 'TAS1'), {}, {
      batchId: row.id,
      lat: route.points[at]!.y,
      lon: route.points[at]!.x,
      recordedAt: fixAt,
      source: 'device',
      ageMinutes: 20 * 60,
      fresh: false,
      gateSince: null,
    }))!;
    expect(marker.live).toBe(false);
    expect(marker.progress!).toBeGreaterThanOrEqual(cum[at]! / total);
  });

  it('a truck pinned in Uzbekistan carries no date — the customer is shown none (O15)', async () => {
    const row = { ...truckRow, departedAt: new Date(Date.now() - 60 * HOUR) };
    const control = (await truckFor(row, ends('KA', 'TAS1'), {}))!;
    expect(control.dated).toBe(true);
    const pinned = (await truckFor(
      { ...row, trackingCheckpoint: { key: 'in_uz', at: new Date(Date.now() - HOUR).toISOString() } },
      ends('KA', 'TAS1'),
      {},
    ))!;
    expect(pinned.dated).toBe(false);
  });

  it('an ARRIVED truck stands at its gate: no date, nothing left', async () => {
    const row = { ...truckRow, status: 'arrived', departedAt: new Date(Date.now() - 110 * HOUR) };
    const marker = (await truckFor(row, ends('YW', 'KA'), {}))!;
    expect(marker.placed).toBe(true);
    expect({ x: marker.x, y: marker.y }).toEqual(WAREHOUSE_POINTS.KA);
    expect(marker.dated).toBe(false);
    expect(marker.progress).toBe(1);
    // The walk alone, 110 h into Yiwu → Kashgar's 144-168 h, put it 70 %
    // along with two days to go (the review measured exactly that).
    const walking = (await truckFor({ ...row, status: 'in_transit' }, ends('YW', 'KA'), {}))!;
    expect(walking.progress!).toBeLessThan(0.9);
    expect(walking.dated).toBe(true);
  });

  it('an arrived truck on a road nobody modelled stands at its gate — not wherever the phone is on the drive back', async () => {
    const row = { ...truckRow, status: 'arrived', departedAt: new Date(Date.now() - 10 * HOUR) };
    const internal = { originCode: 'TAS1', destCode: 'AND', originCountry: 'UZ', destCountry: 'UZ' };
    const marker = (await truckFor(row, internal, {}, {
      batchId: row.id,
      lat: 41.0,
      lon: 70.5,
      recordedAt: new Date(Date.now() - HOUR),
      source: 'device',
      ageMinutes: 60,
      fresh: true,
      gateSince: null,
    }))!;
    expect({ x: marker.x, y: marker.y }).toEqual(WAREHOUSE_POINTS.AND);
    expect(marker.live).toBe(false);
    expect(marker.dated).toBe(false);
  });

  it('a truck standing at its gate: never late on the road — «stuck» after the stuck days since it CAME, on the map and in the bot', async () => {
    const route = routeFor('KA', 'TAS1')!;
    const gate = route.points[route.points.length - 1]!;
    // 300 h out, far past the slowest schedule — and it pulled in a minute
    // ago: the road's lateness is forgiven by arriving (the fourth recheck).
    const row = { ...truckRow, departedAt: new Date(Date.now() - 300 * HOUR) };
    const atYard = (sinceH: number) => ({
      batchId: row.id,
      lat: gate.y,
      lon: gate.x,
      recordedAt: new Date(Date.now() - 60_000),
      source: 'device',
      ageMinutes: 1,
      fresh: true,
      gateSince: new Date(Date.now() - sinceH * HOUR),
    });
    const fresh = (await truckFor(row, ends('KA', 'TAS1'), {}, atYard(1 / 60)))!;
    expect(fresh).toMatchObject({ atGate: true, overdue: false, dated: false, gateStuck: false });
    expect(fresh.gateDays).toBeLessThanOrEqual(1);
    // Three days there with nobody scanning it off: stuck, by the days.
    const stood = (await truckFor(row, ends('KA', 'TAS1'), {}, atYard(72)))!;
    expect(stood).toMatchObject({ atGate: true, overdue: false, gateDays: 3, gateStuck: true });
    // On a road nobody modelled the marker says the same.
    const internal = { originCode: 'TAS1', destCode: 'AND', originCountry: 'UZ', destCountry: 'UZ' };
    const and = WAREHOUSE_POINTS.AND!;
    const atAnd = (await truckFor(row, internal, {}, { ...atYard(72), lat: and.y, lon: and.x }))!;
    expect(atAnd).toMatchObject({ atGate: true, gateDays: 3, gateStuck: true, overdue: false });
    const popup = readFileSync('src/app/(protected)/map/tracking-map.tsx', 'utf8');
    expect(popup).toContain("selTruck.gateStuck ? ` — ${t('atGateStuck')}` : ''");
    expect(popup).not.toContain('atGateLate');
    // The lorry itself goes red, on both renderers, and /trucks' word too.
    expect(popup.match(/tr\.overdue \|\| tr\.gateStuck \? 'fill-bad' : 'fill-warn'/g)?.length).toBe(3);
    expect(readFileSync('src/app/(protected)/map/leaflet-corridor.tsx', 'utf8')).toContain('const alarm = tr.overdue || tr.gateStuck;');
    expect(readFileSync('src/app/(protected)/trucks/page.tsx', 'utf8')).toContain(
      "road.kind === 'overdue' || road.kind === 'stuck' ? 'text-warn' : ''",
    );
    const bot = readFileSync('src/modules/wms/bot/lookup.ts', 'utf8');
    expect(bot).toContain("(marker.gateStuck ? ' — ⏱ tushirishni tekshiring' : '')");
    expect(bot).toContain("marker?.atGate ? 'manzilda, tushirilmagan' : 'yo‘lda'");
    expect(bot).not.toContain('muddati o‘tgan');
  });

  it('the office row of an ARRIVED truck stood since the phone had it in the yard — the first scan does not reset it', async () => {
    const b = await mintBatch('KA', 'TAS1', {
      status: 'arrived',
      departedAt: new Date(Date.now() - 300 * HOUR),
      arrivedAt: new Date(Date.now() - 60_000),
    });
    const fixAgo = (h: number, lat: string, lon: string) => ({
      batchId: b.id,
      lat,
      lon,
      accuracyM: 10,
      recordedAt: new Date(Date.now() - h * HOUR),
      receivedAt: new Date(Date.now() - h * HOUR),
    });
    await db.insert(driverPositions).values([
      fixAgo(120, '40.53', '72.8'),
      fixAgo(96, '41.31', '69.24'),
      fixAgo(2, '41.31', '69.24'),
    ]);
    const row = (await trucksOnRoadRows([b.id])).get(b.id)!;
    expect(row).toMatchObject({ status: 'arrived', kind: 'stuck', days: 4 });
    expect(Math.abs(row.stoodSince!.getTime() - (Date.now() - 96 * HOUR))).toBeLessThan(60_000);
    // Its newest fix is nobody's evidence once it arrived, so it is not read
    // (the sixth recheck: every fix of the drive home was, on every render).
    expect(row.lastPositionAt).toBeNull();

    // The board prints the clock it judges by and orders by it: «Keldi» four
    // days ago (GPS) — not today — and ahead of a truck scanned in yesterday.
    const yesterday = await mintBatch('KA', 'TAS1', {
      status: 'arrived',
      departedAt: new Date(Date.now() - 200 * HOUR),
      arrivedAt: new Date(Date.now() - 30 * HOUR),
    });
    const board = await loadBoard({ permissions: new Set(['plans.manage']), warehouseScoped: false, warehouseIds: [] });
    const cards = board.cards.filter((c): c is BoardTruck => c.type === 'batch');
    const stood = cards.find((c) => c.id === b.id)!;
    const scanned = cards.find((c) => c.id === yesterday.id)!;
    expect(stood).toMatchObject({ arrivedByGps: true, warnings: expect.arrayContaining(['stuck']) });
    expect(Math.abs(new Date(stood.arrivedAt!).getTime() - (Date.now() - 96 * HOUR))).toBeLessThan(60_000);
    expect(scanned.arrivedByGps).toBe(false);
    expect(stood.order).toBeLessThan(scanned.order);

    // The bot's marker for the same truck: at its gate four days, stuck —
    // never «yo'lda» once the first carton is scanned.
    const yard = await latestPositions([
      { id: b.id, originCode: 'KA', destCode: 'TAS1', departedAt: b.departedAt, until: b.arrivedAt },
    ]);
    const marker = (await truckFor(b, ends('KA', 'TAS1'), {}, yard.get(b.id)))!;
    expect(marker).toMatchObject({ atGate: true, gateDays: 4, gateStuck: true, overdue: false });
    const bare = (await truckFor(yesterday, ends('KA', 'TAS1'), {}))!;
    expect(bare).toMatchObject({ atGate: true, gateDays: 1, gateStuck: false });

    // /trucks and the truck card's ladder read the same clock.
    const trucksPage = readFileSync('src/app/(protected)/trucks/page.tsx', 'utf8');
    expect(trucksPage).toContain("row.status === 'in_transit' || row.status === 'arrived'");
    expect(trucksPage).toContain("row.arrivedAt && road?.kind !== 'stuck' ? (");
    expect(readFileSync('src/app/(protected)/batches/[id]/batch-card.tsx', 'utf8')).toContain(
      'arrived: road?.stoodSince ?? batch.arrivedAt,',
    );
    expect(readFileSync('src/app/(protected)/batches/board-card.tsx', 'utf8')).toContain(
      "tb(card.arrivedByGps ? 'arrivedOnGps' : 'arrivedOn', { date: boardDay(card.arrivedAt) })",
    );
  });

  it('a truck nothing honest places is not drawn — its spent walk ends ON the destination warehouse', async () => {
    const row = { ...truckRow, departedAt: new Date(Date.now() - 800 * HOUR) };
    const marker = (await truckFor(row, ends('KA', 'TAS1'), {}))!;
    expect(marker.overdue).toBe(true);
    expect(marker.placed).toBe(false);
  });
});

describe('the evidence a fix is', () => {
  it('a phone clock running ahead is dated by its arrival; a coarse fix is no position; accuracy 0 is kept', async () => {
    const id = truckRow.id;
    const at = (h: number) => new Date(Date.now() + h * HOUR);
    // An honest fix three hours ago.
    await db.insert(driverPositions).values({ batchId: id, lat: '39.9', lon: '74.0', accuracyM: 12, recordedAt: at(-3), receivedAt: at(-3) });
    // A phone a day ahead: stamped tomorrow, received an hour ago.
    await db.insert(driverPositions).values({ batchId: id, lat: '40.1', lon: '73.5', accuracyM: 12, recordedAt: at(24), receivedAt: at(-1) });
    let latest = (await latestPositions([{ id, originCode: 'KA', destCode: 'TAS1' }])).get(id)!;
    expect(latest.recordedAt.getTime()).toBeCloseTo(at(-1).getTime(), -3);
    expect(latest.lat).toBe(40.1);

    // A 20 km cell-tower fix ten minutes ago says nothing about which side
    // of a post the truck stands on.
    await db.insert(driverPositions).values({ batchId: id, lat: '40.5', lon: '72.9', accuracyM: 20_000, recordedAt: at(-1 / 6), receivedAt: at(-1 / 6) });
    latest = (await latestPositions([{ id, originCode: 'KA', destCode: 'TAS1' }])).get(id)!;
    expect(latest.lat).toBe(40.1);

    // A reported accuracy of 0 is a precise fix, not a missing one.
    await db.insert(driverPositions).values({ batchId: id, lat: '40.6', lon: '72.8', accuracyM: 0, recordedAt: at(-1 / 12), receivedAt: at(-1 / 12) });
    latest = (await latestPositions([{ id, originCode: 'KA', destCode: 'TAS1' }])).get(id)!;
    expect(latest.lat).toBe(40.6);
    await db.delete(driverPositions).where(eq(driverPositions.batchId, id));
  });
});

describe('the customer reads the same truck', () => {
  async function ride(batchId: string) {
    await db
      .update(boxes)
      .set({ status: 'in_transit', currentBatchId: batchId, currentWarehouseId: null })
      .where(eq(boxes.lotId, lotId));
  }
  const group = async () => (await cargoOverview(clientId)).find((l) => l.lotId === lotId)!.groups[0]!;

  it('an ARRIVED Yiwu → Kashgar truck with the cartons not yet scanned off: no %, no date, the map at Kashgar', async () => {
    const b = await mintBatch('YW', 'KA', {
      status: 'arrived',
      departedAt: new Date(Date.now() - 110 * HOUR),
      arrivedAt: new Date(Date.now() - HOUR),
    });
    await ride(b.id);
    expect((await group()).transit).toBeNull();
    const truck = (await cabinetMap([clientId])).find((p) => p.kind === 'truck')!;
    expect(truck.point).toEqual(WAREHOUSE_POINTS.KA);
    expect(truck.remainingDays).toBeNull();
  });

  it('a truck nothing honest places is listed on the customer’s map with no point — never on the Tashkent dot', async () => {
    const b = await mintBatch('KA', 'TAS1', { departedAt: new Date(Date.now() - 800 * HOUR) });
    await ride(b.id);
    const truck = (await cabinetMap([clientId])).find((p) => p.kind === 'truck')!;
    expect(truck).toBeDefined();
    expect(truck.point).toBeNull();
  });

  it('a truck due NOW (12 km out, past its slowest pace) shows the customer no date — as the office and the map show none', async () => {
    const b = await mintBatch('KA', 'TAS1', { departedAt: new Date(Date.now() - 70 * HOUR) });
    await ride(b.id);
    const route = routeFor('KA', 'TAS1')!;
    const gate = route.points[route.points.length - 1]!;
    const prev = route.points[route.points.length - 2]!;
    const len = Math.hypot(prev.x - gate.x, prev.y - gate.y);
    const p = { x: gate.x + ((prev.x - gate.x) / len) * 0.11, y: gate.y + ((prev.y - gate.y) / len) * 0.11 };
    await db.insert(driverPositions).values({
      batchId: b.id,
      lat: p.y.toFixed(6),
      lon: p.x.toFixed(6),
      accuracyM: 15,
      recordedAt: new Date(Date.now() - 2 * HOUR),
      receivedAt: new Date(Date.now() - 2 * HOUR),
    });
    const road = (await group()).transit!;
    expect(road.etaFromIso).toBeNull();
    const office = (await trucksOnRoadRows([b.id])).get(b.id)!;
    expect(office.kind).toBe('on_road');
    expect(office.eta).toBeNull();
    const truck = (await cabinetMap([clientId])).find((x) => x.kind === 'truck')!;
    expect(truck.remainingDays).toBeNull();
  });

  it('one lot on two trucks: the one at its gate does not take the road and the date from the one still on the way', async () => {
    const route = routeFor('KA', 'TAS1')!;
    const gate = route.points[route.points.length - 1]!;
    const atGate = await mintBatch('KA', 'TAS1', { departedAt: new Date(Date.now() - 60 * HOUR) });
    const onRoad = await mintBatch('KA', 'TAS1', { departedAt: new Date(Date.now() - 10 * HOUR) });
    const [a, b] = await db.select({ id: boxes.id }).from(boxes).where(eq(boxes.lotId, lotId)).orderBy(boxes.id);
    for (const [box, truck] of [[a!.id, atGate.id], [b!.id, onRoad.id]] as const) {
      await db.update(boxes).set({ status: 'in_transit', currentBatchId: truck, currentWarehouseId: null }).where(eq(boxes.id, box));
    }
    await db.insert(driverPositions).values({
      batchId: atGate.id,
      lat: gate.y.toFixed(6),
      lon: gate.x.toFixed(6),
      accuracyM: 15,
      recordedAt: new Date(Date.now() - HOUR),
      receivedAt: new Date(Date.now() - HOUR),
    });
    const g = await group();
    expect(g.n).toBe(2);
    // The group lands when its LAST carton does: the road truck's date.
    const office = (await trucksOnRoadRows([onRoad.id])).get(onRoad.id)!;
    expect(office.eta).not.toBeNull();
    // Both windows end at the same moment, computed a few milliseconds apart.
    expect(g.transit!.etaToIso).not.toBeNull();
    expect(Math.abs(new Date(g.transit!.etaToIso!).getTime() - new Date(office.eta!.toIso).getTime())).toBeLessThan(60_000);
    expect(g.transit!.progress!).toBeLessThan(0.5);
  });

  it('a dated truck an hour out reads «~0–0.1 kun» on the map and in the bot — never «~0–0»', async () => {
    const b = await mintBatch('KA', 'TAS1', { departedAt: new Date(Date.now() - 70 * HOUR) });
    const route = routeFor('KA', 'TAS1')!;
    const gate = route.points[route.points.length - 1]!;
    const prev = route.points[route.points.length - 2]!;
    const len = Math.hypot(prev.x - gate.x, prev.y - gate.y);
    const p = { x: gate.x + ((prev.x - gate.x) / len) * 0.11, y: gate.y + ((prev.y - gate.y) / len) * 0.11 };
    const marker = (await truckFor(b, ends('KA', 'TAS1'), {}, {
      batchId: b.id,
      lat: p.y,
      lon: p.x,
      recordedAt: new Date(Date.now() - 30 * 60_000),
      source: 'device',
      ageMinutes: 30,
      fresh: true,
      gateSince: null,
    }))!;
    // An hour or so left: dated, and the days say so instead of «0–0».
    expect(marker.overdue).toBe(false);
    expect(marker.dated).toBe(true);
    expect(marker.remainingDays[1]).toBeGreaterThan(0);
    expect(marker.remainingDays[1]).toBeLessThanOrEqual(0.2);
  });

  it('the cabinet’s % follows the driver’s phone, the office’s number to the percent', async () => {
    const b = await mintBatch('KA', 'TAS1', { departedAt: new Date(Date.now() - 30 * HOUR) });
    await ride(b.id);
    const before = (await group()).transit!.progress!;
    const route = routeFor('KA', 'TAS1')!;
    const kg = route.segments.find((s) => s.key === 'kg')!;
    const p = route.points[kg.span[1] - 2]!;
    await db.insert(driverPositions).values({
      batchId: b.id,
      lat: p.y.toFixed(6),
      lon: p.x.toFixed(6),
      accuracyM: 15,
      recordedAt: new Date(Date.now() - HOUR),
      receivedAt: new Date(Date.now() - HOUR),
    });
    const after = (await group()).transit!.progress!;
    expect(after).toBeGreaterThan(before + 0.05);
    const office = (await trucksOnRoadRows([b.id])).get(b.id)!;
    expect(office.source).toBe('gps');
    expect(Math.round(after * 100)).toBe(office.roadPct);
  });
});
