import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  batches,
  boxes,
  clients,
  events,
  notifications,
  users,
  warehouses,
  clientNotices,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, finishLoading, ingestLoadScans, removeLoadedCode } from '@/modules/wms/scanning/service';
import { countLoadCrate, countLoadLot } from '@/modules/wms/scanning/count-load';
import { inventorySnapshot, reconcileInventory } from '@/modules/wms/inventory/service';
import {
  aboardFilter,
  finishUnload,
  ingestUnloadScans,
  landUnloadInput,
  resolveMissingLot,
  unloadRemaining,
} from '@/modules/wms/scanning/unload';
import { countAcceptCrate, countAcceptLot, CountError } from '@/modules/wms/scanning/count-accept';
import { countDoorFor } from '@/modules/wms/scanning/count-door';
import { batchRegister } from '@/modules/wms/reports/queries';
import { buildInvoiceXlsx } from '@/modules/wms/documents/ved-xlsx';
import { createCrate, dissolveCrate } from '@/modules/wms/crates/service';
import ExcelJS from 'exceljs';

/*
 * The QR-siz round's review, made permanent (0112): each case here is a
 * defect an adversarial reviewer PROVED on the merged round, kept as the
 * regression test that would have caught it. Own warehouses (deactivated at
 * the end — audit_log FK), own clients; the cargo stays as data (#183).
 */

const S = String(Date.now()).slice(-6);
let actorId: string;
const W = { cn: '', hub: '', uz: '' };
const madeTrucks: string[] = [];
const madeClients: string[] = [];
const ctx = () => ({ actorId });

async function mintWarehouse(code: string, country: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, batchPrefix: code, name: `Count review ${code}`, country, type, timezone: 'Asia/Tashkent' })
    .returning({ id: warehouses.id });
  return row!.id;
}

let seq = 0;
async function mkLot(boxCount: number, at: string) {
  seq += 1;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `CR${seq}${S}`.slice(0, 10), name: `Count review ${seq} ${S}` })
    .returning({ id: clients.id });
  madeClients.push(client!.id);
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `count-review/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId: at,
      clientId: client!.id,
      dealId: null,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '审查货',
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
  return { lotId, boxes: rows.map((b) => ({ id: b.id, code: b.shortCode })) };
}

async function plan(origin: string, dest: string, lotId: string, take: number) {
  const sub = await submitPlan(
    { originWarehouseId: origin, destWarehouseId: dest, lines: [{ lotId, boxCount: take }] } as never,
    ctx(),
  );
  const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' } as never, ctx());
  madeTrucks.push(batch!.id);
  return batch!;
}

const qr = (batchId: string, code: string, addedOnSpot = false) => ({
  clientEventUuid: uuidv4(),
  batchId,
  code,
  method: 'qr' as const,
  addedOnSpot,
  addedReason: addedOnSpot ? 'review extra' : '',
  scannedAt: new Date().toISOString(),
});

async function aboard(batchId: string) {
  const rows = await db.select({ code: boxes.shortCode }).from(boxes).where(aboardFilter(batchId));
  return rows.map((r) => r.code).sort();
}

const office = (id: string, wh: string) =>
  countDoorFor({ id, permissions: new Set(['plans.manage']), warehouseScoped: false, warehouseIds: [] }, wh)!;

let quickN = 0;
/** A quick truck (no plan): the office counts straight off the origin's shelf. */
async function quickTruck(origin: string, dest: string) {
  quickN += 1;
  const [row] = await db
    .insert(batches)
    .values({
      code: `CRQ${S}${quickN}`,
      originWarehouseId: origin,
      destWarehouseId: dest,
      type: 'transfer',
      status: 'forming',
      createdBy: actorId,
    })
    .returning();
  madeTrucks.push(row!.id);
  return row!;
}

/** What the stocktake at `wh` would do with every carton of these lots, all posted as missing. */
async function stocktakeWritesOff(wh: string, lotIds: string[]) {
  const ids = (await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lotIds))).map((r) => r.id);
  await reconcileInventory(
    { warehouseId: wh, foundHereCodes: [], lostBoxIds: ids, scannedCount: 0 },
    { canMarkLost: true },
    ctx(),
  );
  const rows = await db
    .select({ lotId: boxes.lotId, status: boxes.status })
    .from(boxes)
    .where(inArray(boxes.lotId, lotIds));
  return lotIds.map((lotId) => rows.filter((r) => r.lotId === lotId && r.status === 'lost').length);
}

/** Loaded by phone, «yuklash tugadi», departed — a truck on the road with `take` of the lot. */
async function onTheRoad(lotId: string, take: number) {
  const truck = await plan(W.cn, W.uz, lotId, take);
  const planned = await db
    .select({ code: boxes.shortCode })
    .from(boxes)
    .where(and(eq(boxes.currentBatchId, truck.id), eq(boxes.status, 'planned')));
  const acks = await ingestLoadScans(planned.map((b) => qr(truck.id, b.code)), ctx());
  expect(acks.every((a) => a.result === 'ok')).toBe(true);
  await finishLoading(truck.id, ctx());
  await departBatch(truck.id, ctx());
  return truck;
}

/** Polls the POOL until another session waits on a lock (#873: pg_locks' relation is null for a row wait). */
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

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  W.cn = await mintWarehouse(`CRC${S}`, 'CN', 'origin');
  W.hub = await mintWarehouse(`CRH${S}`, 'CN', 'hub');
  W.uz = await mintWarehouse(`CRU${S}`, 'UZ', 'distribution');
});

afterAll(async () => {
  if (madeClients.length) await db.delete(clientNotices).where(inArray(clientNotices.clientId, madeClients));
  if (madeTrucks.length) {
    const mine = await db.select({ id: events.id }).from(events).where(inArray(events.entityId, madeTrucks));
    if (mine.length) {
      await db.delete(notifications).where(inArray(notifications.eventId, mine.map((e) => e.id)));
      await db.delete(events).where(inArray(events.id, mine.map((e) => e.id)));
    }
    const codes = await db.select({ code: batches.code }).from(batches).where(inArray(batches.id, madeTrucks));
    for (const { code } of codes) {
      await db.delete(notifications).where(sql`${notifications.payload}->>'text' LIKE ${`%${code}%`}`);
    }
  }
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(W).filter(Boolean)));
  await pgClient.end();
});

describe('a truck’s papers across a hub (review cargo-1)', () => {
  it('a carton that rode T1 stays T1’s cargo while the hub reserves it onto T2', async () => {
    const lot = await mkLot(3, W.cn);
    const t1 = await plan(W.cn, W.hub, lot.lotId, 2);
    const acks = await ingestLoadScans(
      [qr(t1.id, lot.boxes[0]!.code), qr(t1.id, lot.boxes[1]!.code), qr(t1.id, lot.boxes[2]!.code, true)],
      ctx(),
    );
    expect(acks.map((a) => a.result)).toEqual(['ok', 'ok', 'ok']);
    await finishLoading(t1.id, ctx());
    await departBatch(t1.id, ctx());
    const u = await ingestUnloadScans(lot.boxes.map((b) => ({ ...qr(t1.id, b.code) })), ctx());
    expect(u.map((a) => a.result)).toEqual(['ok', 'ok', 'ok']);
    await finishUnload(t1.id, ctx());
    const codes = lot.boxes.map((b) => b.code).sort();
    expect(await aboard(t1.id)).toEqual(codes);
    expect((await batchRegister()).find((r) => r.id === t1.id)!.added).toBe(1);

    // The hub plans the next leg: the cartons are `planned` again, on T2.
    await plan(W.hub, W.uz, lot.lotId, 3);
    expect(await aboard(t1.id)).toEqual(codes);
    expect((await batchRegister()).find((r) => r.id === t1.id)!.added).toBe(1);
  });
});

describe('the office count and a phone on an ARRIVED truck (review lock-1)', () => {
  it('meet on the carton, never in a cycle: the count waits, then sees the phone’s landing', async () => {
    const lot = await mkLot(6, W.cn);
    const truck = await onTheRoad(lot.lotId, 6);
    // The first scan flips the truck to `arrived`; from then on a phone never
    // updates the truck row again — its scan events only key-share it.
    const [first] = await ingestUnloadScans([qr(truck.id, lot.boxes[0]!.code)], ctx());
    expect(first!.result).toBe('ok');
    expect((await db.select().from(batches).where(eq(batches.id, truck.id)))[0]!.status).toBe('arrived');

    const X = lot.boxes[5]!;
    let lockedX!: () => void;
    const xLocked = new Promise<void>((r) => (lockedX = r));
    let go!: () => void;
    const gate = new Promise<void>((r) => (go = r));
    // The PHONE: the real body, paused between its carton lock and the rest.
    const phone = db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM boxes WHERE id = ${X.id} FOR UPDATE`);
        lockedX();
        await gate;
        return landUnloadInput(tx, qr(truck.id, X.code), actorId, new Set(), {});
      })
      .then(
        (ack) => ({ ok: true as const, result: ack.result }),
        (err: { code?: string }) => ({ ok: false as const, code: err.code }),
      );
    await xLocked;
    const count = countAcceptLot(
      { batchId: truck.id, lotId: lot.lotId, target: 6, seenArrived: 1, pressId: uuidv4(), overReason: '', confirmArrival: true },
      ctx(),
      { dest: office(actorId, W.uz), origin: office(actorId, W.cn) },
    ).then(
      () => ({ ok: true as const, code: 'ok' }),
      (err: unknown) => ({ ok: false as const, code: err instanceof CountError ? err.code : String(err) }),
    );
    // The count holds the truck row and waits on the phone's carton…
    expect(await waitForLock('boxes')).toBe(true);
    // …and the phone's scan event (a key-share of that row) must not wait on it.
    go();
    const [p, c] = await Promise.all([phone, count]);
    expect(p).toEqual({ ok: true, result: 'ok' });
    // The count then reads the phone's landing and says the screen is stale —
    // an answer, where the cycle made one of the two a deadlock victim.
    expect(c.code).toBe('count_stale');
  });
});

describe('a count is a count in every direction (review cargo-3)', () => {
  it('a first press that only goes DOWN makes the lot the office’s: the phone neither scans it back nor takes it off', async () => {
    const lot = await mkLot(5, W.cn);
    const t = await plan(W.cn, W.uz, lot.lotId, 5);
    const acks = await ingestLoadScans(lot.boxes.slice(0, 3).map((b) => qr(t.id, b.code)), ctx());
    expect(acks.map((a) => a.result)).toEqual(['ok', 'ok', 'ok']);
    const res = await countLoadLot(
      { batchId: t.id, lotId: lot.lotId, target: 2, seenAboard: 3, pressId: uuidv4(), overReason: '' },
      ctx(),
      office(actorId, W.cn),
    );
    expect(res.aboard).toBe(2);
    // The carton the office took off, scanned back on by a phone…
    const [again] = await ingestLoadScans([qr(t.id, lot.boxes[2]!.code)], ctx());
    expect(again).toMatchObject({ result: 'rejected', detail: 'lot_counted' });
    // …and a phone's removal of the office's number.
    await expect(removeLoadedCode(t.id, lot.boxes[0]!.code, ctx())).rejects.toMatchObject({ code: 'lot_counted' });
  });
});

describe('the stocktake never writes off a count-moved pile (review cargo-2, phone-1, cargo-5)', () => {
  it('a load-counted lot the manager landed with «Hammasini qabul qilish»', async () => {
    const lot = await mkLot(4, W.cn);
    const t = await plan(W.cn, W.hub, lot.lotId, 4);
    await countLoadLot(
      { batchId: t.id, lotId: lot.lotId, target: 4, seenAboard: 0, pressId: uuidv4(), overReason: '' },
      ctx(),
      office(actorId, W.cn),
    );
    await finishLoading(t.id, ctx());
    await departBatch(t.id, ctx());
    // The phone is refused the counted lot; the bulk door lands it.
    const [phone] = await ingestUnloadScans([qr(t.id, lot.boxes[0]!.code)], ctx());
    expect(phone).toMatchObject({ result: 'rejected', detail: 'lot_counted' });
    expect((await unloadRemaining(t.id, ctx())).accepted).toBe(4);
    await finishUnload(t.id, ctx());
    const snap = await inventorySnapshot(W.hub);
    const mine = snap.boxes.filter((b) => lot.boxes.some((x) => x.code === b.shortCode));
    expect(mine.map((b) => b.countMoved)).toEqual([true, true, true, true]);
    expect(await stocktakeWritesOff(W.hub, [lot.lotId])).toEqual([0]);
  });

  it('cartons the office placed with a typed number on the missing-lot card', async () => {
    const lot = await mkLot(4, W.cn);
    const t = await onTheRoad(lot.lotId, 4);
    const [landed] = await ingestUnloadScans([qr(t.id, lot.boxes[0]!.code)], ctx());
    expect(landed!.result).toBe('ok');
    await finishUnload(t.id, ctx(), { mayCloseWithMissing: true });
    const res = await resolveMissingLot(
      { batchId: t.id, lotId: lot.lotId, resolution: 'found_here', n: 2, seenMissing: 3 },
      ctx(),
      office(actorId, W.uz),
    );
    expect(res.resolved).toBe(2);
    const snap = await inventorySnapshot(W.uz);
    const placed = snap.boxes.filter((b) => res.shortCodes.includes(b.shortCode));
    expect(placed.map((b) => b.countMoved)).toEqual([true, true]);
    // The phone-scanned carton is witnessed and stays an ordinary one.
    expect(snap.boxes.find((b) => b.shortCode === lot.boxes[0]!.code)?.countMoved).toBe(false);
  });

  it('a pallet pressed «(1 joy)» by the office is a scanned place like any other — not count-moved', async () => {
    const lotA = await mkLot(3, W.cn);
    const lotB = await mkLot(3, W.cn);
    const pa = await createCrate(
      { crateId: uuidv4(), warehouseId: W.cn, lotCounts: [{ lotId: lotA.lotId, count: 3 }], kind: 'palet', logistApproved: true },
      ctx(),
    );
    const pb = await createCrate(
      { crateId: uuidv4(), warehouseId: W.cn, lotCounts: [{ lotId: lotB.lotId, count: 3 }], kind: 'palet', logistApproved: true },
      ctx(),
    );
    const t = await quickTruck(W.cn, W.hub);
    await countLoadCrate({ batchId: t.id, crateId: pa!.id, pressId: uuidv4() }, ctx(), office(actorId, W.cn));
    expect((await ingestLoadScans([qr(t.id, pb!.code)], ctx()))[0]!.result).toBe('ok');
    await finishLoading(t.id, ctx());
    await departBatch(t.id, ctx());
    await countAcceptCrate(
      { batchId: t.id, crateId: pa!.id, pressId: uuidv4(), confirmArrival: true },
      ctx(),
      { dest: office(actorId, W.hub) },
    );
    expect((await ingestUnloadScans([qr(t.id, pb!.code)], ctx()))[0]!.result).toBe('ok');
    await finishUnload(t.id, ctx());
    // Both pallets carry a CR- label: a really-missing one is written off by
    // the stocktake whichever way it came off the truck.
    expect(await stocktakeWritesOff(W.hub, [lotA.lotId, lotB.lotId])).toEqual([3, 3]);
  });
});

describe('the customs invoice’s places are the truck’s own (review cargo-4)', () => {
  /** «Кол-во мест» of every goods line, as the file prints it. */
  async function invoicePlaces(batchId: string): Promise<number[]> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildInvoiceXlsx(batchId))! as never);
    const out: number[] = [];
    wb.worksheets[0]!.eachRow((row) => {
      if (row.getCell(4).value === 'кг') out.push(Number(row.getCell(6).value));
    });
    return out;
  }

  it('a pallet that crossed as one place stays one after the hub dissolves it and builds another', async () => {
    const lot = await mkLot(6, W.cn);
    const crate = await createCrate(
      { crateId: uuidv4(), warehouseId: W.cn, lotCounts: [{ lotId: lot.lotId, count: 4 }], kind: 'palet', logistApproved: true },
      ctx(),
    );
    const sub = await submitPlan(
      { originWarehouseId: W.cn, destWarehouseId: W.hub, lines: [{ lotId: lot.lotId, boxCount: 2 }], crateIds: [crate!.id] } as never,
      ctx(),
    );
    const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' } as never, ctx());
    madeTrucks.push(batch!.id);
    const t = batch!;
    const loose = await db
      .select()
      .from(boxes)
      .where(and(eq(boxes.lotId, lot.lotId), sql`${boxes.crateId} IS NULL`, eq(boxes.currentBatchId, t.id)));
    const acks = await ingestLoadScans([qr(t.id, crate!.code), ...loose.map((b) => qr(t.id, b.shortCode))], ctx());
    expect(acks.map((a) => a.result)).toEqual(['ok', 'ok', 'ok']);
    await finishLoading(t.id, ctx());
    await departBatch(t.id, ctx());
    // Two loose cartons and one pallet: three places.
    expect(await invoicePlaces(t.id)).toEqual([3]);
    const u = await ingestUnloadScans([qr(t.id, crate!.code), ...loose.map((b) => qr(t.id, b.shortCode))], ctx());
    expect(u.every((a) => a.result === 'ok')).toBe(true);
    await finishUnload(t.id, ctx());
    await dissolveCrate(crate!.id, ctx());
    expect(await invoicePlaces(t.id)).toEqual([3]);
    await createCrate(
      { crateId: uuidv4(), warehouseId: W.hub, lotCounts: [{ lotId: lot.lotId, count: 5 }], kind: 'palet', logistApproved: true },
      ctx(),
    );
    expect(await invoicePlaces(t.id)).toEqual([3]);
  });
});
