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
import { departBatch, finishLoading, ingestLoadScans } from '@/modules/wms/scanning/service';
import { aboardFilter, finishUnload, ingestUnloadScans, landUnloadInput } from '@/modules/wms/scanning/unload';
import { countAcceptLot, CountError } from '@/modules/wms/scanning/count-accept';
import { countDoorFor } from '@/modules/wms/scanning/count-door';
import { batchRegister } from '@/modules/wms/reports/queries';

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
