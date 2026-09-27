import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  batches,
  boxes,
  boxMovements,
  clientNotices,
  clients,
  events,
  notifications,
  receiptLots,
  receipts,
  scanEvents,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { createCrate } from '@/modules/wms/crates/service';
import { departBatch, finishLoading, ingestLoadScans } from '@/modules/wms/scanning/service';
import {
  finishUnload,
  ingestUnloadScans,
  remainingToUnload,
  resolveMissingLot,
  unloadRemaining,
} from '@/modules/wms/scanning/unload';
import {
  countAcceptCrate,
  countAcceptLot,
  countAcceptPanel,
  countedLotAwaiting,
  CountError,
  COUNT_CHUNK,
  type CountAcceptInput,
} from '@/modules/wms/scanning/count-accept';
import { countDoorFor, type CountDoor } from '@/modules/wms/scanning/count-door';
import { riderRowsSql } from '@/modules/wms/batches/riders';
import { GROW_LOT_MAX } from '@/modules/wms/receipts/grow-lot';

/**
 * «Sanab qabul» (0112, package B) through the real doors: the office's count
 * press, the phone's unload ingest, «Hammasini qabul qilish», the finish and
 * the per-lot answer to the missing cartons.
 *
 * Its own four warehouses (a Chinese origin, an Uzbek distribution one, a
 * Chinese hub, and a second Uzbek one a scoped logist does NOT hold),
 * DEACTIVATED at the end and never deleted (audit_log FK). The cargo stays —
 * a truck's history is data, not configuration. The events and notification
 * rows this file creates are deleted, or the e2e server's drain would send
 * them.
 */

const S = String(Date.now()).slice(-6);
let actorId: string;
let otherActorId: string;
const W = { cn: '', uz: '', hub: '', uz2: '' };
const madeClients: string[] = [];
const madeTrucks: string[] = [];
const ctx = () => ({ actorId });

async function mintWarehouse(code: string, country: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, batchPrefix: code, name: `Sanab ${code}`, country, type, timezone: 'Asia/Tashkent' })
    .returning({ id: warehouses.id });
  return row!.id;
}

const office = (id: string, wh: string) =>
  countDoorFor({ id, permissions: new Set(['plans.manage']), warehouseScoped: false, warehouseIds: [] }, wh)!;
const doors = (dest: string, origin: string | null = W.cn) => ({
  dest: office(actorId, dest),
  origin: origin ? office(actorId, origin) : null,
});

let seq = 0;
async function mkClient() {
  seq += 1;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `B${seq}${S}`.slice(0, 10), name: `Sanab qabul ${seq} ${S}` })
    .returning({ id: clients.id });
  madeClients.push(client!.id);
  return client!.id;
}

async function mkLot(boxCount: number, clientId?: string) {
  const owner = clientId ?? (await mkClient());
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `sanab/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId: W.cn,
      clientId: owner,
      dealId: null,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '计数货',
          boxCount,
          dimsMode: 'uniform',
          boxLengthCm: 50,
          boxWidthCm: 40,
          boxHeightCm: 30,
          boxWeightKg: 10,
        },
      ],
      extraCosts: [],
    } as never,
    ctx(),
  );
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId)).orderBy(boxes.seqInLot);
  return { lotId, receiptId, clientId: owner, boxes: rows.map((b) => ({ id: b.id, code: b.shortCode })) };
}
type Lot = Awaited<ReturnType<typeof mkLot>>;

async function planTruck(
  lines: { lot: Lot; take: number }[],
  dest = W.uz,
  crateIds: string[] = [],
) {
  const sub = await submitPlan(
    {
      originWarehouseId: W.cn,
      destWarehouseId: dest,
      lines: lines.map((l) => ({ lotId: l.lot.lotId, boxCount: l.take })),
      crateIds,
    } as never,
    ctx(),
  );
  const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' } as never, ctx());
  madeTrucks.push(batch!.id);
  return batch!;
}

const qr = (batchId: string, code: string) => ({
  clientEventUuid: uuidv4(),
  batchId,
  code,
  method: 'qr' as const,
  addedOnSpot: false,
  scannedAt: new Date().toISOString(),
});

/** Plan, load every planned carton by QR, finish, depart — a truck on the road. */
async function onTheRoad(lines: { lot: Lot; take: number }[], dest = W.uz, crateCodes: { id: string; code: string }[] = []) {
  const truck = await planTruck(lines, dest, crateCodes.map((c) => c.id));
  const planned = await db
    .select({ code: boxes.shortCode, crateId: boxes.crateId })
    .from(boxes)
    .where(and(eq(boxes.currentBatchId, truck.id), eq(boxes.status, 'planned')));
  const loose = planned.filter((b) => !b.crateId).map((b) => qr(truck.id, b.code));
  if (loose.length) {
    const acks = await ingestLoadScans(loose, ctx());
    expect(acks.every((a) => a.result === 'ok')).toBe(true);
  }
  for (const crate of crateCodes) {
    const [ack] = await ingestLoadScans([qr(truck.id, crate.code)], ctx());
    expect(ack!.result).toBe('ok');
  }
  await finishLoading(truck.id, ctx());
  await departBatch(truck.id, ctx());
  return truck;
}

function press(
  truckId: string,
  lot: Lot,
  target: number,
  seenArrived: number,
  extra: Partial<CountAcceptInput> = {},
  withDoors: { dest: CountDoor; origin: CountDoor | null } = doors(W.uz),
) {
  return countAcceptLot(
    {
      batchId: truckId,
      lotId: lot.lotId,
      target,
      seenArrived,
      pressId: uuidv4(),
      overReason: '',
      confirmArrival: true,
      ...extra,
    },
    ctx(),
    withDoors,
  );
}

async function boxRow(id: string) {
  return (await db.select().from(boxes).where(eq(boxes.id, id)))[0]!;
}
async function statusCount(lot: Lot, status: string) {
  const rows = await db.select().from(boxes).where(and(eq(boxes.lotId, lot.lotId), eq(boxes.status, status)));
  return rows.length;
}
async function countAudits(truckId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, truckId), sql`${auditLog.after}->'countAccept' IS NOT NULL`));
}
async function eventsOf(type: string, truckId: string) {
  return db.select().from(events).where(and(eq(events.type, type as never), eq(events.entityId, truckId)));
}
async function refused(p: Promise<unknown>): Promise<{ code: string; detail: Record<string, unknown> }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CountError) return { code: err.code, detail: err.detail };
    throw err;
  }
  throw new Error('expected a refusal');
}

beforeAll(async () => {
  const active = await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(2);
  actorId = active[0]!.id;
  otherActorId = active[1]!.id;
  W.cn = await mintWarehouse(`BQC${S}`, 'CN', 'origin');
  W.uz = await mintWarehouse(`BQU${S}`, 'UZ', 'distribution');
  W.hub = await mintWarehouse(`BQH${S}`, 'CN', 'hub');
  W.uz2 = await mintWarehouse(`BQV${S}`, 'UZ', 'distribution');
});

afterAll(async () => {
  if (madeClients.length) await db.delete(clientNotices).where(inArray(clientNotices.clientId, madeClients));
  if (madeTrucks.length) {
    const mine = await db.select({ id: events.id }).from(events).where(inArray(events.entityId, madeTrucks));
    if (mine.length) {
      await db.delete(notifications).where(inArray(notifications.eventId, mine.map((e) => e.id)));
      await db.delete(events).where(inArray(events.id, mine.map((e) => e.id)));
    }
    // The press's own staff Telegrams (BoxLost, UnloadFinished) name the truck.
    const codes = await db.select({ code: batches.code }).from(batches).where(inArray(batches.id, madeTrucks));
    for (const { code } of codes) {
      await db.delete(notifications).where(sql`${notifications.payload}->>'text' LIKE ${`%${code}%`}`);
    }
  }
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(W).filter(Boolean)));
  await pgClient.end();
});

describe('a count lands cartons the way a scan does', () => {
  it('T1: refuses an unconfirmed arrival, then lands the lot, arrives the truck, claims ONE notice, audits the press', async () => {
    const lot = await mkLot(5);
    const truck = await onTheRoad([{ lot, take: 5 }]);
    expect(
      (await refused(press(truck.id, lot, 3, 0, { confirmArrival: false }))).code,
    ).toBe('confirm_arrival_required');
    const [still] = await db.select().from(batches).where(eq(batches.id, truck.id));
    expect(still!.status).toBe('in_transit');
    expect(await statusCount(lot, 'in_transit')).toBe(5);

    const pressId = uuidv4();
    const res = await countAcceptLot(
      { batchId: truck.id, lotId: lot.lotId, target: 3, seenArrived: 0, pressId, overReason: '', confirmArrival: true },
      ctx(),
      doors(W.uz),
    );
    expect([res.landed, res.arrived, res.shortfall, res.replay]).toEqual([3, 3, 2, false]);
    const landed = await db
      .select()
      .from(boxes)
      .where(and(eq(boxes.lotId, lot.lotId), eq(boxes.status, 'ready_for_pickup')));
    expect(landed).toHaveLength(3);
    expect(landed.every((b) => b.currentWarehouseId === W.uz && b.currentBatchId === null)).toBe(true);
    const moves = await db
      .select()
      .from(boxMovements)
      .where(and(inArray(boxMovements.boxId, landed.map((b) => b.id)), eq(boxMovements.refId, truck.id)))
      .then((rows) => rows.filter((m) => m.toStatus === 'ready_for_pickup'));
    expect(moves.map((m) => m.cause)).toEqual(['unload_scan', 'unload_scan', 'unload_scan']);
    const scans = await db.select().from(scanEvents).where(inArray(scanEvents.boxId, landed.map((b) => b.id)));
    const unloadScans = scans.filter((e) => e.type === 'unload');
    expect(unloadScans.map((e) => [e.method, e.manualReason]).sort()).toEqual([
      ['manual', 'count_accept'],
      ['manual', 'count_accept'],
      ['manual', 'count_accept'],
    ]);
    // Per PRESS ids (decision 11).
    for (const e of unloadScans) expect(e.clientEventUuid).toBe(uuidv5(`unload:${e.boxId}`, pressId));
    const [arrived] = await db.select().from(batches).where(eq(batches.id, truck.id));
    expect(arrived!.status).toBe('arrived');
    const notices = await db.select().from(clientNotices).where(eq(clientNotices.clientId, lot.clientId));
    expect(notices).toHaveLength(1);
    // The office's 90-minute window, not the phone's 20 (decision 20).
    expect(notices[0]!.sendAfter.getTime() - Date.now()).toBeGreaterThan(80 * 60_000);
    const audits = await countAudits(truck.id);
    expect(audits).toHaveLength(1);
    const after = (audits[0]!.after as { countAccept: Record<string, unknown> }).countAccept;
    expect(after).toMatchObject({ target: 3, landedCount: 3, arrivalMarked: true, shortfall: 2, pressId });
    expect(after.noticeClientIds).toEqual([lot.clientId]);
  });

  it('T1-hub: a truck into the Kashgar hub lands in stock and tells no client', async () => {
    const lot = await mkLot(3);
    const truck = await onTheRoad([{ lot, take: 3 }], W.hub);
    await press(truck.id, lot, 3, 0, {}, doors(W.hub));
    expect(await statusCount(lot, 'in_stock')).toBe(3);
    expect(await db.select().from(clientNotices).where(eq(clientNotices.clientId, lot.clientId))).toEqual([]);
  });
});

describe('the number is a TOTAL, compared-and-set (decision 10)', () => {
  it('T2: 3 then 5 lands 5, not 8; a stale re-send and a lower number are refused; a double press is nothing', async () => {
    const lot = await mkLot(6);
    const truck = await onTheRoad([{ lot, take: 6 }]);
    await press(truck.id, lot, 3, 0);
    const second = await press(truck.id, lot, 5, 3);
    expect([second.arrivedBefore, second.arrived, second.landed]).toEqual([3, 5, 2]);
    expect(await statusCount(lot, 'ready_for_pickup')).toBe(5);

    expect(await refused(press(truck.id, lot, 3, 0))).toMatchObject({ code: 'count_stale', detail: { arrived: 5 } });
    expect(await refused(press(truck.id, lot, 3, 5))).toMatchObject({
      code: 'count_below_arrived',
      detail: { arrived: 5 },
    });

    const scansBefore = await db.select().from(scanEvents).where(eq(scanEvents.batchId, truck.id));
    const auditsBefore = await countAudits(truck.id);
    const again = await press(truck.id, lot, 5, 3);
    expect(again.replay).toBe(true);
    expect(await db.select().from(scanEvents).where(eq(scanEvents.batchId, truck.id))).toHaveLength(
      scansBefore.length,
    );
    expect(await countAudits(truck.id)).toHaveLength(auditsBefore.length);
  });

  it('T3: a press made against a lot that moved since is refused with what it is now', async () => {
    const lot = await mkLot(5);
    const truck = await onTheRoad([{ lot, take: 5 }]);
    await press(truck.id, lot, 3, 0);
    expect(await refused(press(truck.id, lot, 4, 0))).toMatchObject({ code: 'count_stale', detail: { arrived: 3 } });
  });

  it('T4 (his Q1 b): phones landed 3, the office types the TOTAL 5 — two more land, the rest is the office’s', async () => {
    const lot = await mkLot(6);
    const truck = await onTheRoad([{ lot, take: 6 }]);
    for (const b of lot.boxes.slice(0, 3)) {
      const [ack] = await ingestUnloadScans([qr(truck.id, b.code)], ctx());
      expect(ack!.result).toBe('ok');
    }
    const panel = await countAcceptPanel(truck.id);
    const row = panel.lots.find((l) => l.lotId === lot.lotId)!;
    expect([row.departed, row.arrived, row.phoneScanned, row.awaiting]).toEqual([6, 3, 3, 3]);

    const res = await press(truck.id, lot, 5, 3);
    expect([res.arrivedBefore, res.landed, res.arrived, res.shortfall]).toEqual([3, 2, 5, 1]);
    expect(await statusCount(lot, 'ready_for_pickup')).toBe(5);
    // After the count the lot is the office's: the phone is refused in words.
    const left = (await db.select().from(boxes).where(and(eq(boxes.lotId, lot.lotId), eq(boxes.status, 'in_transit'))))[0]!;
    const [phone] = await ingestUnloadScans([qr(truck.id, left.shortCode)], ctx());
    expect([phone!.result, phone!.detail]).toEqual(['rejected', 'lot_counted']);
    expect(await countedLotAwaiting(truck.id)).toBe(1);
  });
});

describe('«Hammasini qabul qilish» leaves a lot counted HERE to the count (decision 21)', () => {
  it('T5: the phone is refused, a landed carton is a duplicate, accept-all lands the rest and says what it skipped', async () => {
    const counted = await mkLot(5);
    const other = await mkLot(3);
    const truck = await onTheRoad([
      { lot: counted, take: 5 },
      { lot: other, take: 3 },
    ]);
    await press(truck.id, counted, 3, 0);
    const aboard = await db
      .select()
      .from(boxes)
      .where(and(eq(boxes.lotId, counted.lotId), eq(boxes.status, 'in_transit')));
    const [phone] = await ingestUnloadScans([qr(truck.id, aboard[0]!.shortCode)], ctx());
    expect([phone!.result, phone!.detail, phone!.scannedCode]).toEqual([
      'rejected',
      'lot_counted',
      aboard[0]!.shortCode,
    ]);
    expect((await boxRow(aboard[0]!.id)).status).toBe('in_transit');
    const landedOne = (await db
      .select()
      .from(boxes)
      .where(and(eq(boxes.lotId, counted.lotId), eq(boxes.status, 'ready_for_pickup'))))[0]!;
    const [dup] = await ingestUnloadScans([qr(truck.id, landedOne.shortCode)], ctx());
    expect(dup!.result).toBe('duplicate');

    expect(await countedLotAwaiting(truck.id)).toBe(2);
    const buttonNumber = (await remainingToUnload(truck.id)).length - (await countedLotAwaiting(truck.id));
    const res = await unloadRemaining(truck.id, ctx());
    expect([res.accepted, res.skippedCounted]).toEqual([3, 2]);
    expect(res.accepted).toBe(buttonNumber);
    expect(await statusCount(other, 'ready_for_pickup')).toBe(3);
    expect(await statusCount(counted, 'in_transit')).toBe(2);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, truck.id), sql`${auditLog.after} ? 'bulkUnload'`));
    const bulk = audit!.after as { bulkUnload: number; shortCodes: string[]; skippedCounted: number };
    expect([bulk.bulkUnload, bulk.shortCodes.length, bulk.skippedCounted]).toEqual([3, 3, 2]);
  });
});

describe('crates are one place each (Q10 d)', () => {
  it('T6: the count never touches crated members; the crate is accepted whole; accept-all lands the crate and says so', async () => {
    const lot = await mkLot(4);
    const crateId = uuidv4();
    // The crate holds the LOWEST numbers — the first a count would pick if it
    // ever mistook a crated carton for a loose one.
    const crated = lot.boxes.slice(0, 2);
    const crate = await createCrate(
      { crateId, warehouseId: W.cn, boxIds: crated.map((b) => b.id), kind: 'yashik', logistApproved: true },
      ctx(),
    );
    const truck = await onTheRoad([{ lot, take: 2 }], W.uz, [{ id: crateId, code: crate.code }]);
    const row = (await countAcceptPanel(truck.id)).lots.find((l) => l.lotId === lot.lotId)!;
    expect([row.departed, row.awaiting]).toEqual([2, 2]);
    await press(truck.id, lot, 1, 0);
    for (const b of crated) expect((await boxRow(b.id)).status).toBe('in_transit');
    // The button's number = still aboard − the counted lot's loose cartons.
    const buttonNumber = (await remainingToUnload(truck.id)).length - (await countedLotAwaiting(truck.id));
    expect(buttonNumber).toBe(2);
    const res = await unloadRemaining(truck.id, ctx());
    expect(res.accepted).toBe(buttonNumber);
    for (const b of crated) expect((await boxRow(b.id)).status).toBe('ready_for_pickup');
  });

  it('T6b: «Qabul (1 joy)» lands a crate through the crate branch, and a second press is a replay', async () => {
    const lot = await mkLot(2);
    const crateId = uuidv4();
    const crate = await createCrate(
      { crateId, warehouseId: W.cn, boxIds: lot.boxes.map((b) => b.id), kind: 'yashik', logistApproved: true },
      ctx(),
    );
    const truck = await onTheRoad([], W.uz, [{ id: crateId, code: crate.code }]);
    const panel = await countAcceptPanel(truck.id);
    expect(panel.crates).toEqual([{ crateId, code: crate.code, n: 2 }]);
    const pressId = uuidv4();
    const res = await countAcceptCrate(
      { batchId: truck.id, crateId, pressId, confirmArrival: true },
      ctx(),
      { dest: office(actorId, W.uz) },
    );
    expect([res.landed, res.replay]).toEqual([2, false]);
    const scans = (await db.select().from(scanEvents).where(eq(scanEvents.crateId, crateId))).filter(
      (e) => e.type === 'unload',
    );
    expect(scans.map((e) => [e.method, e.manualReason])).toEqual([
      ['crate', 'count_accept'],
      ['crate', 'count_accept'],
    ]);
    const again = await countAcceptCrate(
      { batchId: truck.id, crateId, pressId: uuidv4(), confirmArrival: true },
      ctx(),
      { dest: office(actorId, W.uz) },
    );
    expect(again.replay).toBe(true);
    // A crate event never makes its members' lot «counted».
    expect((await countAcceptPanel(truck.id)).lots.find((l) => l.lotId === lot.lotId)).toBeUndefined();
  });
});

describe('a shortfall is said once per lot (decision 19)', () => {
  it('T7: counted short → one alarm naming the lot and the numbers; the finish groups the missing by lot', async () => {
    const lot = await mkLot(5);
    const truck = await onTheRoad([{ lot, take: 5 }]);
    await press(truck.id, lot, 3, 0);
    const alarms = await eventsOf('CountShortfall', truck.id);
    expect(alarms).toHaveLength(1);
    const p = alarms[0]!.payload as { text: string; presserId: string; lotId: string };
    expect(p.presserId).toBe(actorId);
    expect(p.lotId).toBe(lot.lotId);
    expect(p.text).toContain('Jo‘natilgan: 5');
    expect(p.text).toContain('Sanaldi: 3');
    expect(p.text).toContain('Yetmaydi: 2');
    expect(p.text).toContain(`/batches/${truck.id}`);

    const done = await finishUnload(truck.id, ctx(), { mayCloseWithMissing: true });
    expect(done.missing).toHaveLength(2);
    const [missingEvent] = await eventsOf('MissingInTransit', truck.id);
    const payload = missingEvent!.payload as { lots: { label: string; n: number; product: string }[]; shortCodes: string[] };
    expect(payload.shortCodes).toHaveLength(2);
    expect(payload.lots).toHaveLength(1);
    expect(payload.lots[0]).toMatchObject({ n: 2, product: '计数货' });
    const [lotRow] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot.lotId));
    expect(payload.lots[0]!.label).toMatch(new RegExp(`-${lotRow!.letter}$`));
  });

  it('T7b: three short presses are ONE alarm; the press that closes the gap says «yopildi» once', async () => {
    const lot = await mkLot(5);
    const truck = await onTheRoad([{ lot, take: 5 }]);
    await press(truck.id, lot, 2, 0);
    await press(truck.id, lot, 3, 2);
    await press(truck.id, lot, 4, 3);
    expect(await eventsOf('CountShortfall', truck.id)).toHaveLength(1);
    await press(truck.id, lot, 5, 4);
    const all = await eventsOf('CountShortfall', truck.id);
    expect(all).toHaveLength(2);
    expect(all.map((e) => (e.payload as { text: string }).text).filter((t) => t.includes('yopildi'))).toHaveLength(1);
  });
});

describe('cartons beyond the truck (decision 17, his Q3 b)', () => {
  it('T8: need a reason and the ORIGIN door; land from the origin’s stock as riders with no flag, one alarm', async () => {
    const lot = await mkLot(6);
    const truck = await onTheRoad([{ lot, take: 5 }]);
    expect(await refused(press(truck.id, lot, 6, 0))).toMatchObject({ code: 'over_needs_reason', detail: { max: 5 } });
    // A logist scoped to the destination alone cannot write off Yiwu's stock.
    expect(
      await refused(press(truck.id, lot, 6, 0, { overReason: 'zavod qo‘shib yubordi' }, doors(W.uz, null))),
    ).toMatchObject({ code: 'over_needs_origin_scope' });

    const res = await press(truck.id, lot, 6, 0, { overReason: 'zavod qo‘shib yubordi' });
    expect([res.landed, res.over, res.grown, res.shortfall]).toEqual([6, 1, 0, 0]);
    const sixth = await boxRow(lot.boxes[5]!.id);
    expect([sixth.status, sixth.currentWarehouseId, sixth.flags]).toEqual(['ready_for_pickup', W.uz, []]);
    const [move] = await db
      .select()
      .from(boxMovements)
      .where(and(eq(boxMovements.boxId, sixth.id), eq(boxMovements.refId, truck.id)));
    expect([move!.cause, move!.fromStatus, move!.fromWarehouseId, move!.toWarehouseId]).toEqual([
      'undocumented_transfer',
      'in_stock',
      W.cn,
      W.uz,
    ]);
    const [scan] = await db
      .select()
      .from(scanEvents)
      .where(and(eq(scanEvents.boxId, sixth.id), eq(scanEvents.type, 'unload')));
    expect([scan!.addedOnSpot, scan!.manualReason]).toEqual([true, 'count_over']);
    const alarms = await eventsOf('UndocumentedTransfer', truck.id);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.payload).toMatchObject({
      reason: 'zavod qo‘shib yubordi',
      via: 'count',
      presserId: actorId,
      lot: { n: 1 },
    });
    // Money follows the ride: the sixth carton is this truck's rider…
    const riders = (await db.execute(riderRowsSql({ batches: sql`${truck.id}::uuid` }))) as unknown as {
      box_id: string;
    }[];
    expect(riders.map((r) => r.box_id)).toContain(sixth.id);
    // …and not a risk the dashboard chases for ever (business.ts reads the flag).
    const flagged = await db
      .select({ id: boxes.id })
      .from(boxes)
      .where(and(eq(boxes.lotId, lot.lotId), sql`${boxes.flags} @> '["undocumented_transfer"]'::jsonb`));
    expect(flagged).toEqual([]);
  });

  it('T8b: beyond everything the lot has, the prixod GROWS and the new cartons land as riders', async () => {
    const lot = await mkLot(4);
    const truck = await onTheRoad([{ lot, take: 3 }]);
    const [before] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot.lotId));
    expect(before!.boxCount).toBe(4);
    const res = await press(truck.id, lot, 7, 0, { overReason: 'zavod 3 ta ortiq berdi' });
    expect([res.landed, res.over, res.grown, res.arrived]).toEqual([7, 4, 3, 7]);
    const [after] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot.lotId));
    expect(after!.boxCount).toBe(7);
    expect(Number(after!.totalWeightKg)).toBe(70);
    const all = await db.select().from(boxes).where(eq(boxes.lotId, lot.lotId));
    expect(all).toHaveLength(7);
    expect(all.every((b) => b.status === 'ready_for_pickup' && (b.flags as string[]).length === 0)).toBe(true);
    const grownIds = all.filter((b) => !lot.boxes.some((o) => o.id === b.id)).map((b) => b.id);
    expect(grownIds).toHaveLength(3);
    // Born at the ORIGIN against the receipt, then carried as the truck's riders.
    const births = await db
      .select()
      .from(boxMovements)
      .where(and(inArray(boxMovements.boxId, grownIds), eq(boxMovements.cause, 'lot_edit_add')));
    expect(births.every((m) => m.toWarehouseId === W.cn && m.refId === lot.receiptId)).toBe(true);
    const riders = (await db.execute(riderRowsSql({ batches: sql`${truck.id}::uuid` }))) as unknown as {
      box_id: string;
    }[];
    for (const id of grownIds) expect(riders.map((r) => r.box_id)).toContain(id);
    const [alarm] = await eventsOf('UndocumentedTransfer', truck.id);
    const payload = alarm!.payload as { reason: string; grown: number; lot: { n: number } };
    expect(payload.grown).toBe(3);
    expect(payload.reason).toContain('prixodga +3');
    expect(payload.lot.n).toBe(4);
    const [pressAudit] = await countAudits(truck.id);
    expect((pressAudit!.after as { countAccept: { grown: string[] } }).countAccept.grown).toHaveLength(3);

    expect(
      await refused(press(truck.id, lot, 7 + GROW_LOT_MAX + 1, 7, { overReason: 'juda ko‘p' })),
    ).toMatchObject({ code: 'grow_limit', detail: { max: 7 + GROW_LOT_MAX } });
  });
});

describe('the door is the office’s at the destination (decision 1)', () => {
  it('T9: a door minted for another warehouse or another person opens nothing, and nothing is written', async () => {
    const lot = await mkLot(2);
    const truck = await onTheRoad([{ lot, take: 2 }]);
    expect((await refused(press(truck.id, lot, 2, 0, {}, { dest: office(actorId, W.uz2), origin: null }))).code).toBe(
      'forbidden',
    );
    expect(
      (await refused(press(truck.id, lot, 2, 0, {}, { dest: office(otherActorId, W.uz), origin: null }))).code,
    ).toBe('forbidden');
    // A warehouse manager holds receipts.void and scan.unload — no door at all.
    expect(
      countDoorFor(
        { id: actorId, permissions: new Set(['receipts.void', 'scan.unload']), warehouseScoped: true, warehouseIds: [W.uz] },
        W.uz,
      ),
    ).toBeNull();
    expect(await statusCount(lot, 'in_transit')).toBe(2);
    const [row] = await db.select().from(batches).where(eq(batches.id, truck.id));
    expect(row!.status).toBe('in_transit');
  });
});

describe('the per-lot answer to the missing (decision 22)', () => {
  it('T10: N found here, a stale list refused, N lost with ONE message, and no door without the count door', async () => {
    const lot = await mkLot(5);
    const truck = await onTheRoad([{ lot, take: 5 }]);
    await press(truck.id, lot, 2, 0);
    await finishUnload(truck.id, ctx(), { mayCloseWithMissing: true });
    const dest = office(actorId, W.uz);
    const base = { batchId: truck.id, lotId: lot.lotId };

    await expect(
      resolveMissingLot({ ...base, n: 1, seenMissing: 3, resolution: 'found_here' }, ctx(), null),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const here = await resolveMissingLot({ ...base, n: 1, seenMissing: 3, resolution: 'found_here' }, ctx(), dest);
    expect(here.resolved).toBe(1);
    const [found] = await db
      .select()
      .from(boxMovements)
      .where(and(eq(boxMovements.refId, truck.id), eq(boxMovements.cause, 'found_here')));
    expect(found!.toStatus).toBe('ready_for_pickup');

    await expect(
      resolveMissingLot({ ...base, n: 1, seenMissing: 3, resolution: 'found_here' }, ctx(), dest),
    ).rejects.toMatchObject({ code: 'count_stale' });
    await expect(
      resolveMissingLot({ ...base, n: 3, seenMissing: 2, resolution: 'found_here' }, ctx(), dest),
    ).rejects.toMatchObject({ code: 'resolve_exceeds_missing' });

    const lost = await resolveMissingLot(
      { ...base, n: 2, seenMissing: 2, resolution: 'lost_in_transit', reason: 'yo‘lda tushib qoldi' },
      // A colleague presses it, so the first person is among the told.
      { actorId: otherActorId },
      office(otherActorId, W.uz),
    );
    expect(lost.resolved).toBe(2);
    expect(await statusCount(lot, 'lost')).toBe(2);
    const [code] = await db.select({ code: batches.code }).from(batches).where(eq(batches.id, truck.id));
    const messages = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.type, 'BoxLost'), sql`${notifications.payload}->>'text' LIKE ${`%${code!.code}%`}`));
    // ONE message per recipient for the press, never one per carton.
    const perUser = new Map<string, number>();
    for (const m of messages) perUser.set(m.userId, (perUser.get(m.userId) ?? 0) + 1);
    expect(messages.length).toBeGreaterThan(0);
    expect([...perUser.values()].every((n) => n === 1)).toBe(true);
    expect((messages[0]!.payload as { text: string }).text).toContain('2 karobka');
  });
});

describe('a press bigger than one chunk (decision 3)', () => {
  it(`T11: ${COUNT_CHUNK + 50} cartons land in two chunk transactions sharing one press id`, async () => {
    const lot = await mkLot(COUNT_CHUNK + 50);
    const truck = await onTheRoad([{ lot, take: COUNT_CHUNK + 50 }]);
    const pressId = uuidv4();
    const t0 = performance.now();
    const res = await countAcceptLot(
      { batchId: truck.id, lotId: lot.lotId, target: COUNT_CHUNK + 50, seenArrived: 0, pressId, overReason: '', confirmArrival: true },
      ctx(),
      doors(W.uz),
    );
    const ms = performance.now() - t0;
    console.log(`[count-accept] ${COUNT_CHUNK + 50} cartons in two chunks: ${Math.round(ms)} ms`);
    expect(res.landed).toBe(COUNT_CHUNK + 50);
    const audits = await countAudits(truck.id);
    expect(audits).toHaveLength(2);
    // Each chunk's audit carries its transaction's start: the gap is the
    // first chunk — exactly COUNT_CHUNK cartons — measured (#1135).
    const starts = audits.map((a) => a.createdAt.getTime()).sort((x, y) => x - y);
    console.log(`[count-accept] one ${COUNT_CHUNK}-carton chunk: ${starts[1]! - starts[0]!} ms`);
    expect(new Set(audits.map((a) => (a.after as { countAccept: { pressId: string } }).countAccept.pressId))).toEqual(
      new Set([pressId]),
    );
    expect(await statusCount(lot, 'ready_for_pickup')).toBe(COUNT_CHUNK + 50);
  });
});

describe('concurrency (decision 23)', () => {
  async function waitForLock(match: string) {
    for (let i = 0; i < 250; i += 1) {
      const rows = (await db.execute(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND query ILIKE ${`%${match}%`} AND pid <> pg_backend_pid()`)) as unknown as { n: number }[];
      if (Number(rows[0]?.n ?? 0) > 0) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  }

  it('T12: first contact on an in-transit truck while a phone holds the truck row — no deadlock', async () => {
    const lot = await mkLot(4);
    const truck = await onTheRoad([{ lot, take: 4 }]);
    const helper = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', {
      max: 1,
      onnotice: () => {},
    });
    const held = await helper.reserve();
    try {
      await held`BEGIN`;
      // The phone's first scan flips the truck before it takes its carton.
      await held`UPDATE batches SET status = 'arrived', arrived_at = now() WHERE id = ${truck.id}`;
      const counting = press(truck.id, lot, 3, 0);
      expect(await waitForLock('batches'), 'the count never reached the truck lock').toBe(true);
      // …then the phone takes one of the lot's cartons: with the truck row
      // taken first by the count, this cannot close a cycle.
      await held`SELECT id FROM boxes WHERE id = ${lot.boxes[3]!.id} FOR UPDATE`;
      await held`COMMIT`;
      const res = await counting;
      expect(res.landed).toBe(3);
    } finally {
      held.release();
      await helper.end();
    }
  });

  it('T12b: a chunk re-reads the lot — a carton landed between chunks refuses the rest, and what landed stays', async () => {
    const lot = await mkLot(COUNT_CHUNK + 1);
    const truck = await onTheRoad([{ lot, take: COUNT_CHUNK }]);
    // One carton stays at the origin; the holder takes it, so the SECOND
    // chunk (the only one that reaches beyond the truck) waits on it.
    const spare = lot.boxes[COUNT_CHUNK]!;
    expect((await boxRow(spare.id)).status).toBe('in_stock');
    const helper = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', {
      max: 1,
      onnotice: () => {},
    });
    const held = await helper.reserve();
    let outcome: unknown;
    try {
      await held`BEGIN`;
      await held`SELECT id FROM boxes WHERE id = ${spare.id} FOR UPDATE`;
      const counting = press(truck.id, lot, COUNT_CHUNK + 1, 0, { overReason: 'bittasi ortiq' }).catch((e) => e);
      expect(await waitForLock('boxes'), 'the second chunk never waited').toBe(true);
      // The first chunk committed. Somebody lands a carton of the lot now.
      await held`INSERT INTO box_movements (box_id, from_warehouse_id, to_warehouse_id, from_status, to_status, cause, ref_type, ref_id, actor_id)
                 VALUES (${spare.id}, ${W.cn}, ${W.uz}, 'in_stock', 'ready_for_pickup', 'unload_scan', 'batch', ${truck.id}, ${actorId})`;
      await held`COMMIT`;
      outcome = await counting;
    } finally {
      held.release();
      await helper.end();
    }
    expect(outcome).toBeInstanceOf(CountError);
    expect((outcome as CountError).code).toBe('count_stale');
    expect(await statusCount(lot, 'ready_for_pickup')).toBe(COUNT_CHUNK);
  });
});

describe('the money follows a press that died half-way (decision 17)', () => {
  it('T12c: riders landed by an earlier chunk are re-split even when a later chunk is refused', async () => {
    // 100 aboard, 150 more of the lot at the origin, and the office counts
    // 300: chunk one lands 100 + 100 riders, chunk two needs 50 riders and
    // 50 more cartons than the prixod ever had — and the prixod is voided
    // under it while it waits for the lot row.
    const lot = await mkLot(250);
    const truck = await onTheRoad([{ lot, take: 100 }]);
    const helper = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', {
      max: 1,
      onnotice: () => {},
    });
    const held = await helper.reserve();
    let outcome: unknown;
    try {
      await held`BEGIN`;
      await held`SELECT id FROM receipt_lots WHERE id = ${lot.lotId} FOR UPDATE`;
      const counting = press(truck.id, lot, 300, 0, { overReason: 'zavod ortiq berdi' }).catch((e) => e);
      let waiting = false;
      for (let i = 0; i < 500 && !waiting; i += 1) {
        const rows = (await db.execute(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND query ILIKE '%receipt_lots%' AND pid <> pg_backend_pid()`)) as unknown as { n: number }[];
        waiting = Number(rows[0]?.n ?? 0) > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 20));
      }
      expect(waiting, 'the second chunk never reached the lot').toBe(true);
      await held`UPDATE receipts SET status = 'voided', voided_at = now(), void_reason = 'sinov' WHERE id = ${lot.receiptId}`;
      await held`COMMIT`;
      outcome = await counting;
    } finally {
      held.release();
      await helper.end();
      await db
        .update(receipts)
        .set({ status: 'confirmed', voidedAt: null, voidReason: null })
        .where(eq(receipts.id, lot.receiptId));
    }
    expect(outcome).toBeInstanceOf(CountError);
    expect((outcome as CountError).code).toBe('grow_refused');
    // The first chunk's 200 stand, 100 of them riders of this truck…
    expect(await statusCount(lot, 'ready_for_pickup')).toBe(200);
    // …so the truck's money was queued for its re-split all the same.
    const queued = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pgboss.job
       WHERE name = 'costs.recompute' AND data->>'batchId' = ${truck.id}`)) as unknown as { n: number }[];
    expect(Number(queued[0]?.n ?? 0)).toBeGreaterThan(0);
  });
});

describe('the office’s window for «yukingiz keldi» (decision 20)', () => {
  it('T13: two lots of one client counted half an hour apart still make ONE pending notice', async () => {
    const clientId = await mkClient();
    const a = await mkLot(2, clientId);
    const b = await mkLot(2, clientId);
    const truck = await onTheRoad([
      { lot: a, take: 2 },
      { lot: b, take: 2 },
    ]);
    await press(truck.id, a, 2, 0);
    // Half an hour passes: the phone's 20-minute window would have spoken.
    await db
      .update(clientNotices)
      .set({ sendAfter: sql`${clientNotices.sendAfter} - interval '30 minutes'` })
      .where(eq(clientNotices.clientId, clientId));
    await press(truck.id, b, 2, 0);
    const rows = await db.select().from(clientNotices).where(eq(clientNotices.clientId, clientId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.sendAfter.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('the unload side of the panel', () => {
  it('reads departed/arrived/awaiting/spare per loose lot and the last press', async () => {
    const lot = await mkLot(4);
    const truck = await onTheRoad([{ lot, take: 3 }]);
    await press(truck.id, lot, 2, 0);
    const row = (await countAcceptPanel(truck.id)).lots.find((l) => l.lotId === lot.lotId)!;
    expect([row.departed, row.arrived, row.awaiting, row.spare, row.mode]).toEqual([3, 2, 1, 1, 'counted']);
    expect(row.last?.name).toBeTruthy();
    expect(new Date(row.last!.at).getTime()).not.toBeNaN();
  });
});
