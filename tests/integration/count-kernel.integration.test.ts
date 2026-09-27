import 'dotenv/config';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  batches,
  boxes,
  clientNotices,
  clients,
  events,
  notifications,
  receiptLots,
  scanEvents,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { emitEvent } from '@/modules/platform/events/service';
import {
  processPendingEvents,
  renderTelegramText,
  usersWithRoles,
} from '@/modules/platform/notifications/service';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import {
  departBatch,
  finishLoading,
  ingestLoadScans,
  loadScanInTx,
  ScanError,
} from '@/modules/wms/scanning/service';
import { ingestUnloadScans, landUnloadInput, unloadRemaining } from '@/modules/wms/scanning/unload';
import { lotModeOnTruck } from '@/modules/wms/scanning/count-rules';
import { GrowLotError, growLotInTx } from '@/modules/wms/receipts/grow-lot';
import { auditLog, boxMovements, receipts } from '@/modules/platform/db/schema';

/**
 * The QR-siz kernel (0112), through the real doors: the phone's two ingests,
 * the shared bodies a count door calls, and the notification fan-out.
 *
 * Its own three warehouses (a Chinese origin, an Uzbek distribution one and a
 * Chinese hub), DEACTIVATED at the end and never deleted (audit_log FK). The
 * cargo stays — a truck's history is data, not configuration.
 */

const S = String(Date.now()).slice(-6);
let actorId: string;
const W = { cn: '', uz: '' };
const madeClients: string[] = [];
const eventMarker = `CK${S}`;
const ctx = () => ({ actorId });

async function mintWarehouse(code: string, country: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, batchPrefix: code, name: `Sanash ${code}`, country, type, timezone: 'Asia/Tashkent' })
    .returning({ id: warehouses.id });
  return row!.id;
}

let seq = 0;
async function mkLot(boxCount: number) {
  seq += 1;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `CK${seq}${S}`.slice(0, 10), name: `Sanash ${seq} ${S}` })
    .returning({ id: clients.id });
  madeClients.push(client!.id);
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `sanash/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId: W.cn,
      clientId: client!.id,
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
  return { lotId, boxes: rows.map((b) => ({ id: b.id, code: b.shortCode })) };
}

type Lot = Awaited<ReturnType<typeof mkLot>>;

async function planTruck(lines: { lot: Lot; take: number }[]) {
  const sub = await submitPlan(
    {
      originWarehouseId: W.cn,
      destWarehouseId: W.uz,
      lines: lines.map((l) => ({ lotId: l.lot.lotId, boxCount: l.take })),
    } as never,
    ctx(),
  );
  const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' } as never, ctx());
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
const manual = (batchId: string, code: string, manualReason: string) => ({
  ...qr(batchId, code),
  method: 'manual' as const,
  manualReason,
});

/** What an office count door does for one carton: the shared body, a door, the box by id. */
function countLoad(batchId: string, box: { id: string; code: string }, over = false) {
  return db.transaction((tx) =>
    loadScanInTx(tx, { ...manual(batchId, box.code, 'count_load'), addedOnSpot: over }, actorId, {
      door: 'count_load',
      boxId: box.id,
      quietSpot: true,
    }),
  );
}
function countAccept(batchId: string, box: { id: string; code: string }) {
  return db.transaction((tx) =>
    landUnloadInput(tx, manual(batchId, box.code, 'count_accept'), actorId, new Set(), {
      door: 'count_accept',
      boxId: box.id,
      quietSpot: true,
    }),
  );
}

async function boxRow(id: string) {
  return (await db.select().from(boxes).where(eq(boxes.id, id)))[0]!;
}
async function eventsFor(boxId: string) {
  return db.select().from(scanEvents).where(eq(scanEvents.boxId, boxId));
}
async function depart(batchId: string) {
  await finishLoading(batchId, ctx());
  await departBatch(batchId, ctx());
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  W.cn = await mintWarehouse(`CKC${S}`, 'CN', 'origin');
  W.uz = await mintWarehouse(`CKU${S}`, 'UZ', 'distribution');
});

afterAll(async () => {
  // The unloads' «yukingiz keldi» claims — the notice drain's queue is read
  // by later files — and this file's own events and their notification rows.
  if (madeClients.length) await db.delete(clientNotices).where(inArray(clientNotices.clientId, madeClients));
  const mine = await db
    .select({ id: events.id })
    .from(events)
    .where(sql`${events.payload}->>'batchCode' = ${eventMarker}`);
  if (mine.length) {
    await db.delete(notifications).where(inArray(notifications.eventId, mine.map((e) => e.id)));
    await db.delete(events).where(inArray(events.id, mine.map((e) => e.id)));
  }
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(W).filter(Boolean)));
  await pgClient.end();
});

describe('a server reason from a phone is a forgery', () => {
  it('at loading: refused in words, nothing written', async () => {
    const lot = await mkLot(3);
    const truck = await planTruck([{ lot, take: 3 }]);
    for (const reason of ['count_load', ' count_over ', 'bulk_accept', 'count_accept']) {
      const [ack] = await ingestLoadScans([manual(truck.id, lot.boxes[0]!.code, reason)], ctx());
      expect([reason, ack!.result, ack!.detail]).toEqual([reason, 'rejected', 'reserved_reason']);
    }
    expect((await boxRow(lot.boxes[0]!.id)).status).toBe('planned');
    expect(await eventsFor(lot.boxes[0]!.id)).toEqual([]);
    // An ordinary typed code under a person's own reason still loads.
    const [ok] = await ingestLoadScans([manual(truck.id, lot.boxes[0]!.code, 'stiker yirtilgan')], ctx());
    expect(ok!.result).toBe('ok');
  });

  it('at unloading: refused BEFORE the arrival flip — the truck stays in transit', async () => {
    const lot = await mkLot(2);
    const truck = await planTruck([{ lot, take: 2 }]);
    for (const b of lot.boxes) await ingestLoadScans([qr(truck.id, b.code)], ctx());
    await depart(truck.id);
    for (const reason of ['count_accept', 'count_over', 'bulk_accept']) {
      const [ack] = await ingestUnloadScans([manual(truck.id, lot.boxes[0]!.code, reason)], ctx());
      expect([reason, ack!.result, ack!.detail]).toEqual([reason, 'rejected', 'reserved_reason']);
    }
    const [row] = await db.select().from(batches).where(eq(batches.id, truck.id));
    expect(row!.status).toBe('in_transit');
    expect(row!.arrivedAt).toBeNull();
    expect((await boxRow(lot.boxes[0]!.id)).status).toBe('in_transit');
  });

  it('a door whose reason disagrees with the input throws', async () => {
    const lot = await mkLot(1);
    const truck = await planTruck([{ lot, take: 1 }]);
    await expect(
      db.transaction((tx) =>
        loadScanInTx(tx, manual(truck.id, lot.boxes[0]!.code, 'count_accept'), actorId, { door: 'count_load' }),
      ),
    ).rejects.toThrow(ScanError);
    await expect(
      db.transaction((tx) =>
        loadScanInTx(tx, manual(truck.id, 'ZZ-00000', 'count_load'), actorId, {
          door: 'count_load',
          boxId: lot.boxes[0]!.id,
        }),
      ),
    ).rejects.toThrow('door_box_mismatch');
  });
});

describe('a counted lot is the office’s on its truck (Q4)', () => {
  it('after a count, the phone refuses a sibling, calls the counted carton a duplicate, and scans other lots', async () => {
    const counted = await mkLot(3);
    const other = await mkLot(2);
    const truck = await planTruck([
      { lot: counted, take: 3 },
      { lot: other, take: 2 },
    ]);
    const door = await countLoad(truck.id, counted.boxes[0]!);
    expect(door.result).toBe('ok');
    expect((await boxRow(counted.boxes[0]!.id)).status).toBe('loading');

    const [sibling] = await ingestLoadScans([qr(truck.id, counted.boxes[1]!.code)], ctx());
    expect([sibling!.result, sibling!.detail, sibling!.scannedCode]).toEqual([
      'rejected',
      'lot_counted',
      counted.boxes[1]!.code,
    ]);
    expect((await boxRow(counted.boxes[1]!.id)).status).toBe('planned');
    // Typed by hand under a sticker-lost reason: the same refusal.
    const [typed] = await ingestLoadScans([manual(truck.id, counted.boxes[2]!.code, 'stiker yo‘q')], ctx());
    expect(typed!.detail).toBe('lot_counted');

    const [again] = await ingestLoadScans([qr(truck.id, counted.boxes[0]!.code)], ctx());
    expect(again!.result).toBe('duplicate');

    const [free] = await ingestLoadScans([qr(truck.id, other.boxes[0]!.code)], ctx());
    expect(free!.result).toBe('ok');
    // The door itself goes on counting the lot.
    expect((await countLoad(truck.id, counted.boxes[1]!)).result).toBe('ok');
  });

  it('a QR-siz lot is count-only from the start (Q8): the phone refuses, the door passes', async () => {
    const lot = await mkLot(2);
    const truck = await planTruck([{ lot, take: 2 }]);
    await db.update(receiptLots).set({ qrSkippedAt: new Date() }).where(eq(receiptLots.id, lot.lotId));
    expect(
      await lotModeOnTruck(db, {
        batchId: truck.id,
        lotId: lot.lotId,
        side: 'load',
        countedSide: 'load',
        quickOriginId: null,
      }),
    ).toBe('qrless');
    const [ack] = await ingestLoadScans([qr(truck.id, lot.boxes[0]!.code)], ctx());
    expect([ack!.result, ack!.detail]).toEqual(['rejected', 'qr_less_count_only']);
    expect((await countLoad(truck.id, lot.boxes[0]!)).result).toBe('ok');
  });

  it('a lot counted at loading stays the office’s at unloading — the carton aboard and its sibling left at the origin', async () => {
    const lot = await mkLot(3);
    const truck = await planTruck([{ lot, take: 2 }]);
    await countLoad(truck.id, lot.boxes[0]!);
    await countLoad(truck.id, lot.boxes[1]!);
    await depart(truck.id);

    const [aboard] = await ingestUnloadScans([qr(truck.id, lot.boxes[0]!.code)], ctx());
    expect([aboard!.result, aboard!.detail]).toEqual(['rejected', 'lot_counted']);
    expect((await boxRow(lot.boxes[0]!.id)).status).toBe('in_transit');

    // The third carton never left China. Scanned here it would land as an
    // undocumented transfer of cargo the office counted — refused instead.
    const [origin] = await ingestUnloadScans([qr(truck.id, lot.boxes[2]!.code)], ctx());
    expect([origin!.result, origin!.detail]).toEqual(['rejected', 'lot_counted']);
    const left = await boxRow(lot.boxes[2]!.id);
    expect([left.status, left.currentWarehouseId]).toEqual(['in_stock', W.cn]);
    const rogue = await db
      .select()
      .from(events)
      .where(and(eq(events.type, 'UndocumentedTransfer'), eq(events.entityId, truck.id)));
    expect(rogue).toEqual([]);
  });

  it('«Hammasini qabul qilish» lands load-counted and QR-siz lots, and leaves a lot counted HERE to the count', async () => {
    const loadCounted = await mkLot(2);
    const stickerless = await mkLot(2);
    const hereCounted = await mkLot(2);
    const plain = await mkLot(2);
    const truck = await planTruck([
      { lot: loadCounted, take: 2 },
      { lot: stickerless, take: 2 },
      { lot: hereCounted, take: 2 },
      { lot: plain, take: 2 },
    ]);
    for (const b of loadCounted.boxes) await countLoad(truck.id, b);
    for (const l of [stickerless, hereCounted, plain]) {
      for (const b of l.boxes) {
        const [ack] = await ingestLoadScans([qr(truck.id, b.code)], ctx());
        expect(ack!.result).toBe('ok');
      }
    }
    await depart(truck.id);
    // The stickers came off on the road: the lot is marked on arrival.
    await db.update(receiptLots).set({ qrSkippedAt: new Date() }).where(eq(receiptLots.id, stickerless.lotId));
    expect((await countAccept(truck.id, hereCounted.boxes[0]!)).result).toBe('ok');

    const { accepted } = await unloadRemaining(truck.id, ctx());
    expect(accepted).toBe(6);
    for (const b of [...loadCounted.boxes, ...stickerless.boxes, ...plain.boxes, hereCounted.boxes[0]!]) {
      expect([b.code, (await boxRow(b.id)).status]).toEqual([b.code, 'ready_for_pickup']);
    }
    expect((await boxRow(hereCounted.boxes[1]!.id)).status).toBe('in_transit');
    // …and the phone cannot land it either.
    const [phone] = await ingestUnloadScans([qr(truck.id, hereCounted.boxes[1]!.code)], ctx());
    expect(phone!.detail).toBe('lot_counted');
  });
});

describe('more cartons than the prixod listed (Q3b)', () => {
  it('grows the lot: new codes, the per-box kg and m³, the birth written against the receipt, the reason audited', async () => {
    const lot = await mkLot(3);
    const truck = await planTruck([{ lot, take: 3 }]);
    for (const b of lot.boxes) await countLoad(truck.id, b);
    const [before] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot.lotId));
    const grown = await db.transaction((tx) =>
      growLotInTx(tx, {
        lotId: lot.lotId,
        add: 2,
        warehouseId: W.cn,
        actorId,
        reason: 'zavod 2 ta ortiq berdi',
        batchId: truck.id,
        side: 'load',
      }),
    );
    expect(grown.boxes).toHaveLength(2);
    const [after] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot.lotId));
    expect(after!.boxCount).toBe(5);
    // 50×40×30 cm and 10 kg a carton: the lot grows by exactly two cartons.
    expect(Number(after!.totalWeightKg)).toBe(50);
    expect(Number(after!.totalVolumeM3)).toBeCloseTo(0.3, 4);
    expect(Number(before!.totalWeightKg)).toBe(30);
    const minted = await db.select().from(boxes).where(inArray(boxes.id, grown.boxes.map((b) => b.id)));
    expect(minted.map((b) => [b.status, b.currentWarehouseId, b.seqInLot]).sort()).toEqual([
      ['in_stock', W.cn, 4],
      ['in_stock', W.cn, 5],
    ]);
    const births = await db
      .select()
      .from(boxMovements)
      .where(inArray(boxMovements.boxId, grown.boxes.map((b) => b.id)));
    expect(births.map((m) => [m.cause, m.refType, m.refId])).toEqual([
      ['lot_edit_add', 'receipt', grown.receiptId],
      ['lot_edit_add', 'receipt', grown.receiptId],
    ]);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, grown.receiptId), sql`${auditLog.after}->'lotGrown' IS NOT NULL`));
    expect((audit!.after as { lotGrown: { reason: string; add: number } }).lotGrown).toMatchObject({
      reason: 'zavod 2 ta ortiq berdi',
      add: 2,
    });
    // The new cartons are the lot's, beyond its plan: the count door loads
    // them the way every over-plan carton goes — through the on-spot path.
    const extra = { id: grown.boxes[0]!.id, code: grown.boxes[0]!.shortCode };
    expect((await countLoad(truck.id, extra)).result).toBe('not_on_plan');
    expect((await countLoad(truck.id, extra, true)).result).toBe('ok');
    expect((await boxRow(extra.id)).flags).toEqual(['added_on_spot']);
  });

  it('refuses without a reason, and on a voided prixod', async () => {
    const lot = await mkLot(1);
    const grow = (reason: string) =>
      db.transaction((tx) =>
        growLotInTx(tx, { lotId: lot.lotId, add: 1, warehouseId: W.cn, actorId, reason, batchId: uuidv4(), side: 'load' }),
      );
    await expect(grow('  x ')).rejects.toThrow(GrowLotError);
    const [lotRow] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot.lotId));
    await db
      .update(receipts)
      .set({ status: 'voided', voidedAt: new Date(), voidReason: 'sinov' })
      .where(eq(receipts.id, lotRow!.receiptId));
    await expect(grow('bor edi')).rejects.toThrow('receipt_not_confirmed');
  });
});

describe('the notifications a count press sends', () => {
  async function fanOut(type: 'CountShortfall' | 'BoxScannedOnLoad', payload: Record<string, unknown>) {
    await emitEvent(db, { type, payload: { batchCode: eventMarker, batchId: uuidv4(), ...payload } });
    await processPendingEvents();
    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.type, type), sql`${events.payload}->>'batchCode' = ${eventMarker}`))
      .orderBy(desc(events.id))
      .limit(1);
    const rows = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(eq(notifications.eventId, event!.id));
    return [...new Set(rows.map((r) => r.userId))].sort();
  }

  it('a shortfall reaches the owner and the logists — never the person who pressed', async () => {
    const audience = (await usersWithRoles(['super_admin', 'logist'])).sort();
    expect(audience.length).toBeGreaterThan(1);
    const presser = audience[0]!;
    const got = await fanOut('CountShortfall', { presserId: presser, text: 'Kam keldi' });
    expect(got).toEqual(audience.filter((id) => id !== presser));
  });

  it('an off-plan load names its presser out of the alarm; an old event reaches everyone', async () => {
    const audience = (await usersWithRoles(['logist', 'admin', 'super_admin'])).sort();
    const presser = audience[0]!;
    expect(await fanOut('BoxScannedOnLoad', { addedOnSpot: true, presserId: presser, shortCodes: [] })).toEqual(
      audience.filter((id) => id !== presser),
    );
    expect(await fanOut('BoxScannedOnLoad', { addedOnSpot: true, shortCodes: ['X-00001'] })).toEqual(audience);
  });

  it('lot lines render when the event names its lots, codes when it does not', () => {
    const lotText = renderTelegramText(
      'BoxScannedOnLoad',
      { batchCode: 'YW-7', batchId: 'b', lot: { label: 'GS777-A', product: 'kurtka', n: 3 }, reason: 'zavod ko‘p berdi' },
      'uz',
    );
    expect(lotText).toContain('GS777-A · kurtka: +3');
    expect(lotText).toContain('zavod ko‘p berdi');
    const missing = renderTelegramText(
      'MissingInTransit',
      { batchCode: 'YW-7', batchId: 'b', lots: [{ label: 'GS777-A', product: 'kurtka', n: 2 }] },
      'uz',
    );
    expect(missing).toContain('GS777-A · kurtka: 2');
    expect(missing).not.toContain('+2');
    const old = renderTelegramText('MissingInTransit', { batchCode: 'YW-7', batchId: 'b', shortCodes: ['GS1-00001'] }, 'uz');
    expect(old).toContain('GS1-00001');
  });
});
