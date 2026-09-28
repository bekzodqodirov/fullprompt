import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  batches,
  boxMovements,
  boxes,
  clients,
  handovers,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { ROLE_MATRIX } from '@/modules/platform/rbac/catalog';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { cargoOverview, HISTORY_CAP, issuedHandoversPage } from '@/modules/wms/client-cabinet/service';
import { milestoneCounts } from '@/modules/wms/client-cabinet/stages';
import { loadYuklarView } from '@/modules/wms/client-card/yuklar-view';
import { clientCargoNow } from '@/modules/wms/inventory/client-cargo-now';
import { foldCargoNow, type NowRow } from '@/modules/wms/inventory/client-cargo-fold';

/**
 * The client card's «Yuklar» tab, read as the people who read it.
 *
 * One client carries every edge the tab has an opinion about:
 * - lot A in Yiwu: 3 on the shelf, 2 planned onto a forming truck, plus one
 *   void and one lost carton that are no longer «ours»;
 * - lot B on the export road: 4 on a departed truck, and one more on a truck
 *   already unloaded — declared missing there (`finishUnload`'s flag);
 * - lot C in Tashkent: received in Yiwu forty days ago, three cartons landed
 *   FIVE days ago; its fourth carton landed THIRTY days ago and has been
 *   handed over — it must not date the three still standing;
 * - lot D at the door: 7 of 20 cartons of a 10.1 kg lot (the Mini App's own
 *   «3.54»), the other 13 handed over yesterday with lot C's fourth;
 * - a phone sibling (the same person's other code) with 2 cartons.
 *
 * Every expectation is a literal or a figure computed by ANOTHER surface
 * (`cargoOverview`, the cabinet the client is reading) — never the fold again
 * (#1116).
 */

const S = `${String(Date.now()).slice(-5)}${Math.floor(Math.random() * 90 + 10)}`;
const DAY = 86_400_000;
const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * DAY);
// Unique in its last SEVEN digits (`activeClientsByPhone` matches on those):
// a phone another file also holds would make that file's client this one's
// sibling (the tab's judge, finding 12).
const PHONE = `+99899${S}`;

let actorId: string;
let cn: string;
let uz: string;
let clientA: string;
let clientB: string;
let clientCap: string;
const truckIds: Record<string, string> = {};
const truckCodes: Record<string, string> = {};
const receiptIds: string[] = [];
const lotIds: Record<string, string> = {};
const boxIds: string[] = [];
const handoverIds: string[] = [];
const photoIds: string[] = [];
let boxSeq = 0;

async function wh(code: string, country: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, batchPrefix: code, name: `Yuklar ${code}`, country, type, timezone: 'Asia/Tashkent' })
    .returning({ id: warehouses.id });
  return row!.id;
}

async function truck(key: string, status: string, dest: string, departed: Date | null, arrived: Date | null = null) {
  const id = uuidv4();
  const code = `YK${S}-${key}`;
  await db.insert(batches).values({
    id,
    code,
    originWarehouseId: cn,
    destWarehouseId: dest,
    status,
    departedAt: departed,
    arrivedAt: arrived,
    createdBy: actorId,
  });
  truckIds[key] = id;
  truckCodes[key] = code;
  return id;
}

async function receipt(clientId: string, receivedAt: Date) {
  const [row] = await db
    .insert(receipts)
    .values({
      warehouseId: cn,
      clientId,
      status: 'confirmed',
      createdBy: actorId,
      receivedAt,
      number: `YK${S}-${receiptIds.length + 1}`,
    })
    .returning({ id: receipts.id });
  receiptIds.push(row!.id);
  return row!.id;
}

async function lot(key: string, receiptId: string, letter: string, boxCount: number, kg: string, m3: string) {
  const [row] = await db
    .insert(receiptLots)
    .values({
      receiptId,
      seq: Object.keys(lotIds).length + 1,
      letter,
      productNameZh: `货${key}`,
      productNameRu: `Tovar ${key} ${S}`,
      boxCount,
      dimsMode: 'mixed',
      totalWeightKg: kg,
      totalVolumeM3: m3,
    })
    .returning({ id: receiptLots.id });
  lotIds[key] = row!.id;
  return row!.id;
}

async function box(lotId: string, status: string, wh: string | null, batchId: string | null = null, flags: string[] = []) {
  boxSeq += 1;
  const [row] = await db
    .insert(boxes)
    .values({
      lotId,
      shortCode: `YK${S}${boxSeq}`,
      seqInLot: boxSeq,
      status,
      currentWarehouseId: wh,
      currentBatchId: batchId,
      flags,
    })
    .returning({ id: boxes.id });
  boxIds.push(row!.id);
  return row!.id;
}

async function move(
  boxId: string,
  cause: string,
  refType: string,
  refId: string,
  at: Date,
  from: string | null,
  to: string | null,
  toStatus: string,
) {
  await db.insert(boxMovements).values({
    boxId,
    fromWarehouseId: from,
    toWarehouseId: to,
    fromStatus: 'in_stock',
    toStatus,
    cause,
    refType,
    refId,
    actorId,
    createdAt: at,
  });
}

/** Rode `truckKey` from Yiwu and landed in Tashkent `landedDaysAgo` days ago. */
async function landed(boxId: string, truckKey: string, departedDaysAgo: number, landedDaysAgo: number, toStatus: string) {
  await move(boxId, 'batch_departed', 'batch', truckIds[truckKey]!, ago(departedDaysAgo), cn, uz, 'in_transit');
  await move(boxId, 'unload_scan', 'batch', truckIds[truckKey]!, ago(landedDaysAgo), cn, uz, toStatus);
}

async function photo(lotId: string) {
  const id = uuidv4();
  await db.insert(attachments).values({
    id,
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `yuklar-test/${id}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  photoIds.push(id);
}

beforeAll(async () => {
  actorId = (await db.select().from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  cn = await wh(`YC${S}`, 'CN', 'origin');
  uz = await wh(`YU${S}`, 'UZ', 'distribution');
  clientA = (await db.insert(clients).values({ clientCode: `YA${S}`, name: `Yuklar A ${S}`, phones: [PHONE] }).returning())[0]!.id;
  clientB = (await db.insert(clients).values({ clientCode: `YB${S}`, name: `Yuklar B ${S}`, phones: [PHONE] }).returning())[0]!.id;
  clientCap = (await db.insert(clients).values({ clientCode: `YH${S}`, name: `Yuklar H ${S}` }).returning())[0]!.id;

  await truck('T1', 'forming', uz, null);
  await truck('T2', 'in_transit', uz, ago(3));
  await truck('T0', 'closed', uz, ago(35), ago(30));
  await truck('T3', 'closed', uz, ago(12), ago(5));
  await truck('T5', 'unloaded', uz, ago(20), ago(15));

  const ra = await receipt(clientA, ago(40));
  // Lot A — Yiwu: 3 standing, 2 planned onto T1, one void and one lost.
  const a = await lot('A', ra, 'A', 7, '70', '0.7');
  for (let i = 0; i < 3; i += 1) await box(a, 'in_stock', cn);
  for (let i = 0; i < 2; i += 1) await box(a, 'planned', cn, truckIds.T1!);
  await box(a, 'void', cn);
  await box(a, 'lost', cn);
  await photo(a);
  // Lot B — 4 on the export road, 1 declared missing on the unloaded T5.
  const b = await lot('B', ra, 'B', 5, '50', '0.5');
  for (let i = 0; i < 4; i += 1) {
    const id = await box(b, 'in_transit', null, truckIds.T2!);
    await move(id, 'batch_departed', 'batch', truckIds.T2!, ago(3), cn, uz, 'in_transit');
  }
  const lostOnRoad = await box(b, 'in_transit', null, truckIds.T5!, ['missing_in_transit']);
  await move(lostOnRoad, 'batch_departed', 'batch', truckIds.T5!, ago(20), cn, uz, 'in_transit');
  // Lot C — three standing in Tashkent since five days ago; the fourth
  // landed thirty days ago and was handed over.
  const c = await lot('C', ra, 'C', 4, '40', '0.4');
  const early = await box(c, 'issued', uz);
  await landed(early, 'T0', 35, 30, 'in_stock');
  for (let i = 0; i < 3; i += 1) await landed(await box(c, 'in_stock', uz), 'T3', 12, 5, 'in_stock');
  await photo(c);
  // Lot D — 7 of 20 at the door; 13 handed over yesterday.
  const d = await lot('D', ra, 'D', 20, '10.1', '0.2');
  const issuedD: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const id = await box(d, i < 7 ? 'ready_for_pickup' : 'issued', uz);
    await landed(id, 'T3', 12, 5, 'ready_for_pickup');
    if (i >= 7) issuedD.push(id);
  }
  const [h] = await db
    .insert(handovers)
    .values({
      clientId: clientA,
      warehouseId: uz,
      kind: 'issued_to_client',
      personName: `Oluvchi ${S}`,
      personPhone: '+998900000000',
      createdBy: actorId,
      createdAt: ago(1),
    })
    .returning({ id: handovers.id });
  handoverIds.push(h!.id);
  for (const id of [early, ...issuedD]) await move(id, 'issued', 'handover', h!.id, ago(1), uz, uz, 'issued');

  // The sibling — the same person's other code, 2 cartons in Yiwu.
  const rb = await receipt(clientB, ago(2));
  const e = await lot('E', rb, 'A', 2, '20', '0.2');
  for (let i = 0; i < 2; i += 1) await box(e, 'in_stock', cn);
});

afterAll(async () => {
  await db.delete(attachments).where(inArray(attachments.id, photoIds));
  await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
  await db.delete(handovers).where(inArray(handovers.id, handoverIds));
  await db.delete(handovers).where(eq(handovers.clientId, clientCap));
  await db.delete(boxes).where(inArray(boxes.id, boxIds));
  await db.delete(receiptLots).where(inArray(receiptLots.id, Object.values(lotIds)));
  await db.delete(receipts).where(inArray(receipts.id, receiptIds));
  await db.delete(batches).where(inArray(batches.id, Object.values(truckIds)));
  // Deleted, not merely deactivated: nothing here was written through an
  // audited action, and a leftover active client on this phone would become
  // every later file's sibling (the judge's finding 12, #653).
  await db.delete(clients).where(inArray(clients.id, [clientA, clientB, clientCap]));
  await db.delete(warehouses).where(inArray(warehouses.id, [cn, uz]));
  await pgClient.end();
});

const MATRIX: Record<string, readonly string[]> = ROLE_MATRIX;
const OWNER = { id: 'owner', permissions: new Set(MATRIX.super_admin), warehouseScoped: false, warehouseIds: [] as string[] };
const SELLER = { id: 'seller', permissions: new Set(MATRIX.sales_manager), warehouseScoped: false, warehouseIds: [] as string[] };
/** An invented scoped role that also reads the funnel (the design's edge case). */
const TASHKENT_DESK = () => ({
  id: 'desk',
  permissions: new Set([...MATRIX.warehouse_operator!, 'crm.leads']),
  warehouseScoped: true,
  warehouseIds: [uz],
});

const today = () => tashkentDay();
const rowOf = (rows: readonly NowRow[], key: string) => rows.find((r) => r.lotId === lotIds[key])!;

describe('where the cargo is now, section by section', () => {
  it('counts each step the way the owner reads it — void, lost and the missing carton out', async () => {
    const view = await loadYuklarView(OWNER, clientA, { days: 90, today: today() });
    const counts = Object.fromEntries(
      Object.entries(view.now.sections).map(([s, v]) => [s, v.total.boxes]),
    );
    expect(counts).toEqual({ china: 5, transit: 4, uz: 3, ready: 7 });
    // 50 + 40 + 30 + 3.54 kg and 0.5 + 0.4 + 0.3 + 0.07 m³, each a share of its lot.
    expect(view.now.total).toEqual({ boxes: 19, kg: 123.54, m3: 1.27 });
    // The carton the unload declared missing: its own line, its own truck.
    expect(view.now.missing).toEqual([{ truckId: truckIds.T5, n: 1 }]);
  });

  it('dates what stands in Tashkent from its arrival THERE — «5 kun», not 40 and not 30', async () => {
    const view = await loadYuklarView(OWNER, clientA, { days: 90, today: today() });
    const c = rowOf(view.now.sections.uz.rows, 'C');
    expect(c.n).toBe(3);
    expect(c.days).toBe(5);
    expect(c.arrivedOn.map((a) => a.code)).toEqual([truckCodes.T3]);
    expect(c.kg).toBe(30);
  });

  it('names the truck a carton rides and the one a planned carton is going onto', async () => {
    const view = await loadYuklarView(OWNER, clientA, { days: 90, today: today() });
    expect(rowOf(view.now.sections.transit.rows, 'B').truckId).toBe(truckIds.T2);
    expect(rowOf(view.now.sections.china.rows, 'A').parts).toEqual([
      { status: 'in_stock', truckId: null, n: 3 },
      { status: 'planned', truckId: truckIds.T1, n: 2 },
    ]);
    expect(view.trucks.get(truckIds.T2!)?.code).toBe(truckCodes.T2);
  });

  it('reads 3.54 kg for 7 of 20 boxes of 10.1 kg — and so does the cabinet the client holds', async () => {
    const view = await loadYuklarView(OWNER, clientA, { days: 90, today: today() });
    const d = rowOf(view.now.sections.ready.rows, 'D');
    expect(d.kg).toBe(3.54);
    const cabinet = (await cargoOverview(clientA)).find((l) => l.lotId === lotIds.D)!;
    expect(cabinet.weightKg).toBe(d.kg);
  });

  it('buckets like the Mini App: the same five steps, except the carton the office knows is lost', async () => {
    const view = await loadYuklarView(OWNER, clientA, { days: 90, today: today() });
    const cabinet = milestoneCounts((await cargoOverview(clientA)).flatMap((lot) => lot.groups));
    const missing = view.now.missing.reduce((acc, m) => acc + m.n, 0);
    expect(cabinet.china).toBe(view.now.sections.china.total.boxes);
    expect(cabinet.transit).toBe(view.now.sections.transit.total.boxes);
    expect(cabinet.ready).toBe(view.now.sections.ready.total.boxes);
    // The customer's screen still shows the declared-missing carton as «in
    // Uzbekistan» (its truck is unloaded); the office's does not.
    expect(cabinet.uz).toBe(view.now.sections.uz.total.boxes + missing);
  });

  it('keeps the phone sibling a chip — its cartons are counted there and never in this Σ', async () => {
    const view = await loadYuklarView(OWNER, clientA, { days: 90, today: today() });
    expect(view.siblings).toEqual([{ id: clientB, code: `YB${S}`, boxes: 2 }]);
    expect(view.now.total.boxes).toBe(19);
    // The sibling's own card counts its own cargo and names this code back.
    const back = await loadYuklarView(OWNER, clientB, { days: 90, today: today() });
    expect(back.now.total.boxes).toBe(2);
    expect(back.siblings).toEqual([{ id: clientA, code: `YA${S}`, boxes: 19 }]);
  });
});

describe('what was handed over', () => {
  it('lists the handover with both trucks its cartons rode, and whose act may be opened', async () => {
    const view = await loadYuklarView(OWNER, clientA, { days: 90, today: today() });
    expect(view.history.capped).toBe(false);
    const [h] = view.history.rows;
    expect(h!.id).toBe(handoverIds[0]);
    expect(h!.legs.map((leg) => leg.batchCode).sort()).toEqual([truckCodes.T0, truckCodes.T3].sort());
    expect(view.legTruck.get(truckCodes.T3!)).toBe(truckIds.T3);
    expect(view.actOpen.has(h!.id)).toBe(true);
    // A seller works the card and may not print the act (the act's door).
    const seller = await loadYuklarView(SELLER, clientA, { days: 90, today: today() });
    expect(seller.actOpen.size).toBe(0);
  });

  it('says «oxirgi 60 ta» only when the cap really cut the list', async () => {
    const rows = Array.from({ length: HISTORY_CAP }, (_, i) => ({
      clientId: clientCap,
      warehouseId: uz,
      kind: 'issued_to_client',
      personName: `Cap ${i}`,
      personPhone: '+998900000000',
      createdBy: actorId,
      createdAt: ago(1 + i / 100),
    }));
    await db.insert(handovers).values(rows);
    const exactly = await issuedHandoversPage(clientCap, 90);
    expect(exactly.rows).toHaveLength(HISTORY_CAP);
    expect(exactly.capped).toBe(false);
    await db.insert(handovers).values({ ...rows[0]!, personName: 'Cap extra', createdAt: ago(3) });
    const over = await issuedHandoversPage(clientCap, 90);
    expect(over.rows).toHaveLength(HISTORY_CAP);
    expect(over.capped).toBe(true);
  });
});

describe('every link is asked of the door of the page it opens', () => {
  it('a Tashkent desk opens the Yiwu prixod whose cartons stand in Tashkent (the near half)', async () => {
    const view = await loadYuklarView(TASHKENT_DESK(), clientA, { days: 90, today: today() });
    expect(view.receiptsOpen.has(receiptIds[0]!)).toBe(true);
  });

  it('a desk in neither warehouse opens no prixod, no truck, no photograph', async () => {
    const stranger = { ...TASHKENT_DESK(), warehouseIds: [uuidv4()] };
    const view = await loadYuklarView(stranger, clientA, { days: 90, today: today() });
    expect(view.receiptsOpen.size).toBe(0);
    expect([...view.trucks.values()].some((t) => t.open)).toBe(false);
    expect(view.photoRows.size).toBe(0);
    expect(view.actOpen.size).toBe(0);
  });

  it('a photograph is offered only where the row’s cargo stands near the reader', async () => {
    const view = await loadYuklarView(TASHKENT_DESK(), clientA, { days: 90, today: today() });
    const c = rowOf(view.now.sections.uz.rows, 'C');
    const a = rowOf(view.now.sections.china.rows, 'A');
    expect(view.photos.get(lotIds.C!)).toBeTruthy();
    expect(view.photos.get(lotIds.A!)).toBeTruthy();
    expect(view.photoRows.has(c.key)).toBe(true);
    // Lot A stands in Yiwu: the Tashkent desk is not shown its photograph.
    expect(view.photoRows.has(a.key)).toBe(false);
  });
});

describe('the rows read is the bot’s too', () => {
  it('reads this code alone', async () => {
    const data = await clientCargoNow([clientA]);
    expect(new Set(data.rows.map((r) => r.clientId))).toEqual(new Set([clientA]));
    const folded = foldCargoNow(data.rows, data.trucks, null, today());
    expect(folded.total.boxes).toBe(19);
  });
});
