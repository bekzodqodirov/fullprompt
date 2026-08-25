import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clientNotices,
  clients,
  events,
  receiptLots,
  receipts,
  scanEvents,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { claimArrivalNotice, NOTICE_ARRIVED } from '@/modules/wms/notices/arrival';
import { emitArrivalStaffEvent, staffPendingNotices } from '@/modules/wms/notices/arrival-staff';
import { ingestUnloadScans } from '@/modules/wms/scanning/unload';

/**
 * «10 ta karobka kelsa 10 ta sms» (owner, 2026-08-25) — the seller's arrival
 * message moves onto the same claim the customer's has used since round 98.
 *
 * What these tests pin: the per-scan path emits NOTHING (or the old noise
 * returns unnoticed), the staff event fires ONCE per truck with the real
 * totals, it fires whatever the Telegram side did (a client with no linked
 * chat must not cost their seller the message), and a second unloading
 * session re-arms it.
 */
const STAMP = String(Date.now()).slice(-6);
let actorId = '';
let whOrigin = '';
let whDest = '';
let clientId = '';
let batchId = '';
let boxIds: string[] = [];
const madeReceipts: string[] = [];

async function landOne(index: number) {
  const code = `AS${STAMP}-${index}`;
  const acks = await ingestUnloadScans(
    [
      {
        clientEventUuid: crypto.randomUUID(),
        batchId,
        code,
        method: 'qr',
        scannedAt: new Date().toISOString(),
      },
    ],
    { actorId, ip: null, userAgent: null },
  );
  return acks[0]!;
}

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({
      phone: `+99893${STAMP}1`,
      fullName: `AS scanner ${STAMP}`,
      passwordHash: 'x',
      active: true,
    })
    .returning();
  actorId = u!.id;
  const wh = async (code: string, type: string) => {
    const [row] = await db
      .insert(warehouses)
      .values({
        code,
        name: `AS ${code}`,
        country: type === 'origin' ? 'CN' : 'UZ',
        type,
        timezone: 'Asia/Tashkent',
        batchPrefix: code,
      })
      .returning();
    return row!.id;
  };
  whOrigin = await wh(`ASO${STAMP}`.slice(0, 8), 'origin');
  // A customs warehouse, because that is what every Uzbek destination is and
  // the arrival claim only runs where cargo lands ready_for_pickup.
  whDest = await wh(`ASD${STAMP}`.slice(0, 8), 'customs');
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `AS${STAMP}`.slice(0, 10), name: `AS ${STAMP}` })
    .returning();
  clientId = client!.id;

  const [receipt] = await db
    .insert(receipts)
    .values({
      warehouseId: whOrigin,
      clientId,
      status: 'confirmed',
      confirmedAt: new Date(),
      createdBy: actorId,
    })
    .returning();
  madeReceipts.push(receipt!.id);
  const [lot] = await db
    .insert(receiptLots)
    .values({
      receiptId: receipt!.id,
      seq: 1,
      letter: 'A',
      dimsMode: 'mixed',
      productNameZh: '测试',
      productNameRu: 'Тест',
      boxCount: 3,
      totalWeightKg: '30',
      totalVolumeM3: '0.9',
    })
    .returning();
  const [batch] = await db
    .insert(batches)
    .values({
      code: `ASB${STAMP}`,
      originWarehouseId: whOrigin,
      destWarehouseId: whDest,
      status: 'in_transit',
      departedAt: new Date(),
      createdBy: actorId,
    })
    .returning();
  batchId = batch!.id;

  const rows = await db
    .insert(boxes)
    .values(
      [0, 1, 2].map((i) => ({
        lotId: lot!.id,
        shortCode: `AS${STAMP}-${i}`,
        seqInLot: i + 1,
        status: 'in_transit',
        currentBatchId: batchId,
        currentWarehouseId: null,
      })),
    )
    .returning();
  boxIds = rows.map((r) => r.id);
  // The departure movement the summary's membership reads.
  await db.insert(boxMovements).values(
    boxIds.map((id) => ({
      boxId: id,
      fromWarehouseId: whOrigin,
      toWarehouseId: whDest,
      fromStatus: 'loading',
      toStatus: 'in_transit',
      cause: 'batch_departed',
      refType: 'batch',
      refId: batchId,
      actorId,
    })),
  );
});

afterAll(async () => {
  await db.delete(events).where(and(eq(events.entityType, 'batch'), eq(events.entityId, batchId)));
  await db.delete(clientNotices).where(eq(clientNotices.clientId, clientId));
  if (boxIds.length) {
    await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
    await db.delete(scanEvents).where(inArray(scanEvents.boxId, boxIds));
    await db.delete(boxes).where(inArray(boxes.id, boxIds));
  }
  const lotIds = (
    await db.select({ id: receiptLots.id }).from(receiptLots).where(inArray(receiptLots.receiptId, madeReceipts))
  ).map((r) => r.id);
  if (lotIds.length) await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
  await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  await db.delete(batches).where(eq(batches.id, batchId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, [whOrigin, whDest]));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

const readyEvents = () =>
  db
    .select({ id: events.id, payload: events.payload })
    .from(events)
    .where(and(eq(events.type, 'ReadyForPickup'), eq(events.entityId, batchId)));

describe('the seller hears about a truck ONCE', () => {
  it('scanning three cartons emits no staff event and claims exactly one notice', async () => {
    for (const i of [0, 1, 2]) {
      const ack = await landOne(i);
      expect(ack.result).toBe('ok');
    }
    // The whole point: the event no longer rides the scan.
    expect(await readyEvents()).toHaveLength(0);
    const notices = await db
      .select()
      .from(clientNotices)
      .where(and(eq(clientNotices.clientId, clientId), eq(clientNotices.refId, batchId)));
    expect(notices).toHaveLength(1);
    // …and it remembers who was scanning, or an automation rule assigning to
    // «whoever did it» finds nobody minutes later.
    expect(notices[0]!.claimedBy).toBe(actorId);
    expect(notices[0]!.staffNotifiedAt).toBeNull();
  });

  it('one event, with the TRUCK’s totals and not one carton’s', async () => {
    // Its own row, by batch — `staffPendingNotices` is global and this suite
    // shares one database (#380). The selector itself is proven below.
    const [due] = await db
      .select({ id: clientNotices.id })
      .from(clientNotices)
      .where(and(eq(clientNotices.clientId, clientId), eq(clientNotices.refId, batchId)));
    expect(due).toBeTruthy();
    // …and it IS due: the sweep's selector finds it once its window passes.
    const swept = await staffPendingNotices(200, new Date(Date.now() + 60 * 60_000));
    expect(swept.some((r) => r.id === due!.id)).toBe(true);
    const res = await emitArrivalStaffEvent(due!.id);
    expect(res.emitted).toBe(true);

    const rows = await readyEvents();
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.boxCount).toBe(3);
    expect(payload.staffOnly).toBe(true);
    expect(payload.clientId).toBe(clientId);

    // Pressed twice — a retry after a Telegram failure must not re-announce.
    const again = await emitArrivalStaffEvent(due!.id);
    expect(again.emitted).toBe(false);
    expect(again.reason).toBe('already_notified');
    expect(await readyEvents()).toHaveLength(1);
  });

  it('a second unloading session re-arms the claim, so wave two is announced too', async () => {
    // The truck came back the next morning with one more carton for the same
    // client: the unique index makes the claim a no-op, and without the
    // re-arm nobody — customer or seller — is ever told about it.
    const [receipt] = await db
      .insert(receipts)
      .values({
        warehouseId: whOrigin,
        clientId,
        status: 'confirmed',
        confirmedAt: new Date(),
        createdBy: actorId,
      })
      .returning();
    madeReceipts.push(receipt!.id);
    const [lot] = await db
      .insert(receiptLots)
      .values({
        receiptId: receipt!.id,
        seq: 1,
        letter: 'B',
        dimsMode: 'mixed',
        productNameZh: '第二波',
        boxCount: 1,
        totalWeightKg: '10',
        totalVolumeM3: '0.3',
      })
      .returning();
    const [late] = await db
      .insert(boxes)
      .values({
        lotId: lot!.id,
        shortCode: `AS${STAMP}-9`,
        seqInLot: 1,
        status: 'in_transit',
        currentBatchId: batchId,
        currentWarehouseId: null,
      })
      .returning();
    boxIds.push(late!.id);
    await db.insert(boxMovements).values({
      boxId: late!.id,
      fromWarehouseId: whOrigin,
      toWarehouseId: whDest,
      fromStatus: 'loading',
      toStatus: 'in_transit',
      cause: 'batch_departed',
      refType: 'batch',
      refId: batchId,
      actorId,
    });

    const ack = await landOne(9);
    expect(ack.result).toBe('ok');
    const [notice] = await db
      .select()
      .from(clientNotices)
      .where(and(eq(clientNotices.clientId, clientId), eq(clientNotices.refId, batchId)));
    // Re-armed: the staff fence is clear again and the row is pending.
    expect(notice!.staffNotifiedAt).toBeNull();
    expect(notice!.status).toBe('pending');

    const res = await emitArrivalStaffEvent(notice!.id);
    expect(res.emitted).toBe(true);
    const rows = await readyEvents();
    expect(rows).toHaveLength(2);
    // The second event describes the delivery as it now is — all four boxes.
    const payload = rows[1]!.payload as Record<string, unknown>;
    expect(payload.boxCount).toBe(4);
  });

  it('claims and events are per CLIENT, and the fence is the notice id', async () => {
    const notices = await db
      .select()
      .from(clientNotices)
      .where(eq(clientNotices.kind, NOTICE_ARRIVED));
    expect(notices.every((n) => n.clientId !== null)).toBe(true);
    // A claim for a client with no cargo on this truck cannot be minted by
    // the scan path; the summary refuses it if one somehow is.
    const [ghost] = await db
      .insert(clients)
      .values({ clientCode: `ASG${STAMP}`.slice(0, 10), name: `AS ghost ${STAMP}` })
      .returning();
    await claimArrivalNotice(db, ghost!.id, batchId, { windowMinutes: 0, actorId });
    const [row] = await db
      .select()
      .from(clientNotices)
      .where(and(eq(clientNotices.clientId, ghost!.id), eq(clientNotices.refId, batchId)));
    const res = await emitArrivalStaffEvent(row!.id);
    expect(res.emitted).toBe(false);
    expect(res.reason).toBe('nothing_landed');
    await db.delete(clientNotices).where(eq(clientNotices.clientId, ghost!.id));
    await db.update(clients).set({ active: false }).where(eq(clients.id, ghost!.id));
  });
});
