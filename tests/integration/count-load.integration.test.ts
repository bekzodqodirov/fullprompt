import 'dotenv/config';
import ExcelJS from 'exceljs';
import postgres from 'postgres';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  batches,
  boxes,
  boxMovements,
  clients,
  events,
  loadPlans,
  notifications,
  receiptLots,
  scanEvents,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import {
  departBatch,
  finishLoading,
  ingestLoadScans,
  qrlessUncountedByTruck,
  removeLoadedCode,
  ScanError,
} from '@/modules/wms/scanning/service';
import { batchMemberFilter } from '@/modules/wms/scanning/unload';
import { countDoorFor, type CountDoor } from '@/modules/wms/scanning/count-door';
import { countOnlyLotsOnTruck } from '@/modules/wms/scanning/count-rules';
import {
  countableLotsAt,
  countedOnTruck,
  countLoadCrate,
  countLoadLot,
  countLoadPanel,
  CountError,
  type CountLoadInput,
} from '@/modules/wms/scanning/count-load';
import { createCrate } from '@/modules/wms/crates/service';
import { buildPackingPhotosXlsx } from '@/modules/wms/documents/packing-photos-xlsx';
import { batchRegister, staffActivity } from '@/modules/wms/reports/queries';
import { GROW_LOT_MAX } from '@/modules/wms/receipts/grow-lot';

/**
 * «Sanab yuklash» — the office's count-load door (0112), through the real
 * service: the lot's cartons move through the phone's own ingest body, the
 * number is a TOTAL (the owner's Q1 = b: cartons a phone scanned count), a
 * count beyond the prixod GROWS the lot (Q3 = b), and the readers that
 * print a truck's cargo read what is on it rather than what was ever
 * scanned (decision 25).
 *
 * Its own three warehouses — a Chinese origin, an Uzbek destination and an
 * Uzbek distribution warehouse for the ready-for-pickup case — DEACTIVATED at
 * the end, never deleted (audit_log FK). The cargo stays: a truck's history
 * is data, not configuration (#183).
 */

const S = String(Date.now()).slice(-6);
let actorId: string;
const W = { cn: '', uz: '', dist: '' };
const madeClients: string[] = [];
const madeBatches: string[] = [];
const ctx = () => ({ actorId });

async function mintWarehouse(code: string, country: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, batchPrefix: code, name: `Sanab ${code}`, country, type, timezone: 'Asia/Tashkent' })
    .returning({ id: warehouses.id });
  return row!.id;
}

let seq = 0;
async function mkLot(boxCount: number, at = W.cn) {
  seq += 1;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `CL${seq}${S}`.slice(0, 10), name: `Sanab ${seq} ${S}` })
    .returning({ id: clients.id });
  madeClients.push(client!.id);
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
      warehouseId: at,
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
  return { lotId, clientId: client!.id, boxes: rows.map((b) => ({ id: b.id, code: b.shortCode })) };
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
  madeBatches.push(batch!.id);
  return batch!;
}

let quickN = 0;
async function quickTruck(origin: string, dest: string) {
  quickN += 1;
  const [row] = await db
    .insert(batches)
    .values({
      code: `CLQ${S}${quickN}`,
      originWarehouseId: origin,
      destWarehouseId: dest,
      type: 'transfer',
      status: 'forming',
      createdBy: actorId,
    })
    .returning();
  madeBatches.push(row!.id);
  return row!;
}

const qr = (batchId: string, code: string) => ({
  clientEventUuid: uuidv4(),
  batchId,
  code,
  method: 'qr' as const,
  addedOnSpot: false,
  scannedAt: new Date().toISOString(),
});

function doorAt(warehouseId: string, id = actorId): CountDoor {
  return countDoorFor({ id, permissions: new Set(['plans.manage']), warehouseScoped: false, warehouseIds: [] }, warehouseId)!;
}

/** One office press. `seen` defaults to what is aboard now — the screen's own number. */
async function count(
  batchId: string,
  lot: Lot,
  target: number,
  o: { seen?: number; reason?: string; pressId?: string; door?: CountDoor; origin?: string } = {},
) {
  const seen = o.seen ?? (await aboardOf(batchId, lot.lotId));
  const input: CountLoadInput = {
    batchId,
    lotId: lot.lotId,
    target,
    seenAboard: seen,
    pressId: o.pressId ?? uuidv4(),
    overReason: o.reason ?? '',
  };
  return countLoadLot(input, ctx(), o.door ?? doorAt(o.origin ?? W.cn));
}

async function aboardOf(batchId: string, lotId: string) {
  const rows = await db
    .select({ id: boxes.id })
    .from(boxes)
    .where(
      and(
        eq(boxes.lotId, lotId),
        eq(boxes.currentBatchId, batchId),
        eq(boxes.status, 'loading'),
        sql`${boxes.crateId} IS NULL`,
      ),
    );
  return rows.length;
}
async function boxRow(id: string) {
  return (await db.select().from(boxes).where(eq(boxes.id, id)))[0]!;
}
async function statusOf(lot: Lot) {
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lot.lotId)).orderBy(boxes.seqInLot);
  return rows.map((b) => `${b.seqInLot}:${b.status}${b.currentBatchId ? '@T' : ''}${(b.flags as string[]).length ? '!' : ''}`);
}
async function refusal(p: Promise<unknown>): Promise<CountError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof CountError) return error;
    throw error;
  }
  throw new Error('the press was not refused');
}
async function countAudits(batchId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, batchId), sql`${auditLog.after} ? 'countLoad'`));
}
async function spotEvents(batchId: string) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.type, 'BoxScannedOnLoad'), eq(events.entityId, batchId)));
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  W.cn = await mintWarehouse(`CLC${S}`, 'CN', 'origin');
  W.uz = await mintWarehouse(`CLU${S}`, 'UZ', 'customs');
  W.dist = await mintWarehouse(`CLD${S}`, 'UZ', 'distribution');
});

afterAll(async () => {
  if (madeBatches.length) {
    const mine = await db.select({ id: events.id }).from(events).where(inArray(events.entityId, madeBatches));
    if (mine.length) {
      await db.delete(notifications).where(inArray(notifications.eventId, mine.map((e) => e.id)));
      await db.delete(events).where(inArray(events.id, mine.map((e) => e.id)));
    }
    const codes = (await db.select({ code: batches.code }).from(batches).where(inArray(batches.id, madeBatches))).map(
      (b) => b.code,
    );
    for (const code of codes) {
      await db.delete(notifications).where(sql`${notifications.payload}->>'text' LIKE ${`%${code}%`}`);
    }
  }
  await db
    .update(warehouses)
    .set({ active: false })
    .where(inArray(warehouses.id, Object.values(W).filter(Boolean)));
  await pgClient.end();
});

describe('a press moves cartons through the phone’s own body', () => {
  it('counting 3 of a planned 5: three scan events with the office’s reason, one audit row, the truck loading', async () => {
    const lot = await mkLot(5);
    const truck = await planTruck([{ lot, take: 5 }]);
    const pressId = uuidv4();
    const res = await count(truck.id, lot, 3, { pressId });
    expect([res.before, res.aboard, res.added, res.over, res.grown, res.unchanged]).toEqual([0, 3, 3, 0, 0, false]);
    expect(await statusOf(lot)).toEqual(['1:loading@T', '2:loading@T', '3:loading@T', '4:planned@T', '5:planned@T']);
    for (const box of lot.boxes.slice(0, 3)) {
      const ev = await db.select().from(scanEvents).where(eq(scanEvents.boxId, box.id));
      expect(ev.map((e) => [e.type, e.method, e.manualReason, e.clientEventUuid, e.addedOnSpot])).toEqual([
        ['load', 'manual', 'count_load', uuidv5(`load:${box.id}`, pressId), false],
      ]);
      const moves = await db
        .select()
        .from(boxMovements)
        .where(and(eq(boxMovements.boxId, box.id), eq(boxMovements.refId, truck.id)));
      expect(moves.map((m) => m.cause).sort()).toEqual(['load_scan', 'plan_approved']);
    }
    const [b] = await db.select().from(batches).where(eq(batches.id, truck.id));
    expect(b!.status).toBe('loading');
    const [plan] = await db.select().from(loadPlans).where(eq(loadPlans.batchId, truck.id));
    expect(plan!.status).toBe('loading');
    const audits = await countAudits(truck.id);
    expect(audits).toHaveLength(1);
    expect((audits[0]!.after as { countLoad: Record<string, unknown> }).countLoad).toMatchObject({
      lotId: lot.lotId,
      target: 3,
      aboard: 3,
      plan: 5,
      added: lot.boxes.slice(0, 3).map((b) => b.code),
    });
  });

  it('a total, not an increment: the same number again is a no-op with no audit; a larger one adds the difference', async () => {
    const lot = await mkLot(5);
    const truck = await planTruck([{ lot, take: 5 }]);
    await count(truck.id, lot, 3);
    const again = await count(truck.id, lot, 3, { seen: 3 });
    expect(again.unchanged).toBe(true);
    expect(await countAudits(truck.id)).toHaveLength(1);
    const events3 = await db.select().from(scanEvents).where(eq(scanEvents.batchId, truck.id));
    expect(events3).toHaveLength(3);
    const five = await count(truck.id, lot, 5, { seen: 3 });
    expect(five.added).toBe(2);
    expect(await statusOf(lot)).toEqual(['1:loading@T', '2:loading@T', '3:loading@T', '4:loading@T', '5:loading@T']);
  });

  it('the dial goes down and back up and lands where a straight press lands', async () => {
    const lot = await mkLot(5);
    const truck = await planTruck([{ lot, take: 5 }]);
    await count(truck.id, lot, 5);
    await count(truck.id, lot, 2);
    expect(await statusOf(lot)).toEqual(['1:loading@T', '2:loading@T', '3:planned@T', '4:planned@T', '5:planned@T']);
    const back = await db
      .select()
      .from(boxMovements)
      .where(and(eq(boxMovements.boxId, lot.boxes[4]!.id), eq(boxMovements.cause, 'load_removed')));
    expect(back.map((m) => [m.fromStatus, m.toStatus])).toEqual([['loading', 'planned']]);
    await count(truck.id, lot, 5);
    const fresh = await mkLot(5);
    const other = await planTruck([{ lot: fresh, take: 5 }]);
    await count(other.id, fresh, 5);
    expect(await statusOf(lot)).toEqual(await statusOf(fresh));
    // On, off, on: the press down is a count event too (review cargo-3), so
    // the history says what the office did in both directions.
    const seqFive = await db.select().from(scanEvents).where(eq(scanEvents.boxId, lot.boxes[4]!.id));
    expect(seqFive.map((e) => e.manualReason)).toEqual(['count_load', 'count_load', 'count_load']);
  });

  it('a stale press re-sent after a correction is refused with the truth', async () => {
    const lot = await mkLot(5);
    const truck = await planTruck([{ lot, take: 5 }]);
    await count(truck.id, lot, 5, { seen: 0 });
    await count(truck.id, lot, 2, { seen: 5 });
    // A second tab still showing 5 asks for 4.
    const err = await refusal(count(truck.id, lot, 4, { seen: 5 }));
    expect([err.code, err.detail.current]).toEqual(['count_stale', 2]);
    expect(await aboardOf(truck.id, lot.lotId)).toBe(2);
  });

  it('a press replayed with its own id is a conflict, never a success', async () => {
    const lot = await mkLot(3);
    const truck = await planTruck([{ lot, take: 3 }]);
    const pressId = uuidv4();
    await count(truck.id, lot, 3, { pressId, seen: 0 });
    await count(truck.id, lot, 0, { seen: 3 });
    const err = await refusal(count(truck.id, lot, 3, { pressId, seen: 0 }));
    expect(err.code).toBe('count_conflict');
    expect(await aboardOf(truck.id, lot.lotId)).toBe(0);
  });
});

describe('the office’s number includes what the phones scanned (Q1 = b)', () => {
  it('phone scanned 3, office total 5 → 2 loaded by count, 5 aboard; the phone is then refused; down takes the office’s first', async () => {
    const lot = await mkLot(6);
    const truck = await planTruck([{ lot, take: 6 }]);
    for (const box of lot.boxes.slice(0, 3)) {
      const [ack] = await ingestLoadScans([qr(truck.id, box.code)], ctx());
      expect(ack!.result).toBe('ok');
    }
    const panel = await countLoadPanel({ id: truck.id, originWarehouseId: W.cn });
    const row = panel.rows.find((r) => r.lotId === lot.lotId)!;
    expect([row.aboard, row.phoneScanned, row.mode]).toEqual([3, 3, 'scanning']);
    const res = await count(truck.id, lot, 5, { seen: 3 });
    expect([res.before, res.aboard, res.added, res.phoneScanned]).toEqual([3, 5, 2, 3]);
    expect(await statusOf(lot)).toEqual([
      '1:loading@T',
      '2:loading@T',
      '3:loading@T',
      '4:loading@T',
      '5:loading@T',
      '6:planned@T',
    ]);
    const [phone] = await ingestLoadScans([qr(truck.id, lot.boxes[5]!.code)], ctx());
    expect([phone!.result, phone!.detail]).toEqual(['rejected', 'lot_counted']);
    // Down to 2: the office's two first (highest seq), then the phones' — seq 3.
    await count(truck.id, lot, 2);
    expect(await statusOf(lot)).toEqual([
      '1:loading@T',
      '2:loading@T',
      '3:planned@T',
      '4:planned@T',
      '5:planned@T',
      '6:planned@T',
    ]);
  });

  it('the phone cannot take a counted carton off; another lot’s still comes off', async () => {
    const lot = await mkLot(2);
    const other = await mkLot(1);
    const truck = await planTruck([
      { lot, take: 2 },
      { lot: other, take: 1 },
    ]);
    await count(truck.id, lot, 2);
    await ingestLoadScans([qr(truck.id, other.boxes[0]!.code)], ctx());
    await expect(removeLoadedCode(truck.id, lot.boxes[0]!.code, ctx())).rejects.toThrow('lot_counted');
    expect((await boxRow(lot.boxes[0]!.id)).status).toBe('loading');
    const off = await removeLoadedCode(truck.id, other.boxes[0]!.code, ctx());
    expect(off.removed).toEqual([other.boxes[0]!.code]);
  });
});

describe('beyond the plan, and beyond the prixod', () => {
  it('over the plan needs a reason, carries the ⚠ mark, and sends ONE alarm for the press', async () => {
    const lot = await mkLot(6);
    const truck = await planTruck([{ lot, take: 3 }]);
    const noReason = await refusal(count(truck.id, lot, 5));
    expect([noReason.code, noReason.detail.plan]).toEqual(['over_reason_required', 3]);
    const res = await count(truck.id, lot, 5, { reason: 'zavod ko‘p berdi' });
    expect([res.added, res.over, res.grown]).toEqual([3, 2, 0]);
    expect(await statusOf(lot)).toEqual([
      '1:loading@T',
      '2:loading@T',
      '3:loading@T',
      '4:loading@T!',
      '5:loading@T!',
      '6:in_stock',
    ]);
    const causes = await db
      .select({ cause: boxMovements.cause })
      .from(boxMovements)
      .where(and(eq(boxMovements.boxId, lot.boxes[3]!.id), eq(boxMovements.refId, truck.id)));
    expect(causes.map((c) => c.cause)).toEqual(['loaded_on_spot']);
    const alarms = await spotEvents(truck.id);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.payload).toMatchObject({
      countLoad: true,
      presserId: actorId,
      addedOnSpot: true,
      reason: 'zavod ko‘p berdi',
      shortCodes: [lot.boxes[3]!.code, lot.boxes[4]!.code],
      lot: { n: 2 },
    });
    // Down to 4: the flagged carton with the highest seq goes home clean.
    await count(truck.id, lot, 4);
    const five = await boxRow(lot.boxes[4]!.id);
    expect([five.status, five.currentBatchId, five.flags]).toEqual(['in_stock', null, []]);
    expect((await boxRow(lot.boxes[0]!.id)).status).toBe('loading');
  });

  it('finish, then count back to the plan: the released cartons are re-reserved — no mark, no alarm', async () => {
    const lot = await mkLot(5);
    const truck = await planTruck([{ lot, take: 5 }]);
    await count(truck.id, lot, 3);
    const done = await finishLoading(truck.id, ctx());
    expect(done.shortLoaded).toBe(2);
    await count(truck.id, lot, 5, { seen: 3 });
    expect(await statusOf(lot)).toEqual(['1:loading@T', '2:loading@T', '3:loading@T', '4:loading@T', '5:loading@T']);
    const reReserve = await db
      .select()
      .from(boxMovements)
      .where(
        and(
          eq(boxMovements.boxId, lot.boxes[3]!.id),
          eq(boxMovements.cause, 'plan_approved'),
          eq(boxMovements.refId, truck.id),
        ),
      );
    expect(reReserve).toHaveLength(2);
    expect(await spotEvents(truck.id)).toEqual([]);
  });

  it('beyond the prixod grows the lot — with a reason — and the alarm says how many were added', async () => {
    const lot = await mkLot(3);
    const truck = await planTruck([{ lot, take: 3 }]);
    expect((await refusal(count(truck.id, lot, 5))).code).toBe('over_reason_required');
    const tooMany = await refusal(count(truck.id, lot, 3 + GROW_LOT_MAX + 1, { reason: 'juda ko‘p' }));
    expect([tooMany.code, tooMany.detail.max]).toEqual(['grow_too_many', GROW_LOT_MAX]);
    const res = await count(truck.id, lot, 5, { reason: 'zavod 2 ta ortiq' });
    expect([res.added, res.over, res.grown, res.aboard]).toEqual([3, 0, 2, 5]);
    const [row] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot.lotId));
    expect(row!.boxCount).toBe(5);
    const all = await db.select().from(boxes).where(eq(boxes.lotId, lot.lotId)).orderBy(boxes.seqInLot);
    expect(all.map((b) => [b.seqInLot, b.status, (b.flags as string[]).join()])).toEqual([
      [1, 'loading', ''],
      [2, 'loading', ''],
      [3, 'loading', ''],
      [4, 'loading', 'added_on_spot'],
      [5, 'loading', 'added_on_spot'],
    ]);
    const [alarm] = await spotEvents(truck.id);
    expect(alarm!.payload).toMatchObject({ grown: 2, lot: { n: 2 } });
    expect(String((alarm!.payload as { reason: string }).reason)).toContain('prixodga +2');
    const [press] = await countAudits(truck.id);
    expect((press!.after as { countLoad: { grown: string[] } }).countLoad.grown).toEqual([all[3]!.shortCode, all[4]!.shortCode]);
  });
});

describe('a quick truck', () => {
  it('lists the origin’s lots, counts them plain, and puts them back where they stood', async () => {
    const lot = await mkLot(6);
    const truck = await quickTruck(W.cn, W.uz);
    const listed = await countableLotsAt({ id: truck.id, originWarehouseId: W.cn });
    expect(listed.lots.find((l) => l.lotId === lot.lotId)?.spare).toBe(6);
    await count(truck.id, lot, 4);
    const four = await db
      .select({ cause: boxMovements.cause })
      .from(boxMovements)
      .where(and(eq(boxMovements.refId, truck.id), inArray(boxMovements.boxId, lot.boxes.map((b) => b.id))));
    expect(four.map((m) => m.cause)).toEqual(['load_scan', 'load_scan', 'load_scan', 'load_scan']);
    expect(await spotEvents(truck.id)).toEqual([]);
    await count(truck.id, lot, 1);
    expect(await statusOf(lot)).toEqual(['1:loading@T', '2:in_stock', '3:in_stock', '4:in_stock', '5:in_stock', '6:in_stock']);
    // Once it touches the truck it leaves the picker for the panel.
    const again = await countableLotsAt({ id: truck.id, originWarehouseId: W.cn });
    expect(again.lots.some((l) => l.lotId === lot.lotId)).toBe(false);
  });

  it('a ready-for-pickup carton taken back off is ready for pickup again', async () => {
    const lot = await mkLot(3, W.dist);
    await db.update(boxes).set({ status: 'ready_for_pickup' }).where(eq(boxes.lotId, lot.lotId));
    const truck = await quickTruck(W.dist, W.uz);
    await count(truck.id, lot, 2, { origin: W.dist });
    await count(truck.id, lot, 0, { origin: W.dist });
    const rows = await db.select().from(boxes).where(eq(boxes.lotId, lot.lotId));
    expect(rows.map((b) => b.status)).toEqual(['ready_for_pickup', 'ready_for_pickup', 'ready_for_pickup']);
  });
});

describe('crates move only as crates', () => {
  it('a count never touches crated cartons; the crate goes on as one place', async () => {
    const lot = await mkLot(5);
    const crateId = uuidv4();
    await createCrate(
      {
        crateId,
        warehouseId: W.cn,
        boxIds: lot.boxes.slice(3).map((b) => b.id),
        kind: 'yashik',
        logistApproved: true,
      } as never,
      ctx(),
    );
    const truck = await planTruck([{ lot, take: 3 }]);
    // The crate on the plan too: a crate line reserves its own boxes.
    await db
      .update(boxes)
      .set({ status: 'planned', currentBatchId: truck.id })
      .where(inArray(boxes.id, lot.boxes.slice(3).map((b) => b.id)));
    await count(truck.id, lot, 3);
    expect((await boxRow(lot.boxes[3]!.id)).status).toBe('planned');
    // A fourth LOOSE carton does not exist, so it would grow the prixod — the
    // crated two are never taken for it.
    expect((await refusal(count(truck.id, lot, 4))).code).toBe('over_reason_required');
    const panel = await countLoadPanel({ id: truck.id, originWarehouseId: W.cn });
    expect(panel.crates.find((c) => c.crateId === crateId)).toMatchObject({ boxes: 2, aboard: 0 });
    const res = await countLoadCrate({ batchId: truck.id, crateId, pressId: uuidv4() }, ctx(), doorAt(W.cn));
    expect(res.loaded).toBe(2);
    expect((await boxRow(lot.boxes[3]!.id)).status).toBe('loading');
    // Crate events never make the lot «counted» on their own — this lot was
    // counted loose, so it is; a lot moved ONLY as a crate would not be.
    const ev = await db.select().from(scanEvents).where(eq(scanEvents.boxId, lot.boxes[3]!.id));
    expect(ev.map((e) => [e.method, e.manualReason])).toEqual([['crate', 'count_load']]);
  });
});

describe('the door', () => {
  it('opens only for this person at this truck’s origin', async () => {
    const lot = await mkLot(2);
    const truck = await planTruck([{ lot, take: 2 }]);
    const elsewhere = await refusal(count(truck.id, lot, 1, { door: doorAt(W.uz) }));
    expect(elsewhere.code).toBe('forbidden');
    const [someone] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.active, true), sql`${users.id} <> ${actorId}`))
      .limit(1);
    const borrowed = await refusal(count(truck.id, lot, 1, { door: doorAt(W.cn, someone!.id) }));
    expect(borrowed.code).toBe('forbidden');
    expect(await aboardOf(truck.id, lot.lotId)).toBe(0);
  });

  it('a lot that is neither on the truck nor on the origin’s shelf is not the press’s to count', async () => {
    const away = await mkLot(2, W.dist);
    const truck = await quickTruck(W.cn, W.uz);
    expect((await refusal(count(truck.id, away, 2))).code).toBe('lot_not_here');
  });
});

describe('«yuklash tugadi» and a QR-siz lot (decision 28)', () => {
  it('a COUNTED QR-siz lot short-loads its remainder like any other', async () => {
    const lot = await mkLot(5);
    await db.update(receiptLots).set({ qrSkippedAt: new Date() }).where(eq(receiptLots.id, lot.lotId));
    const truck = await planTruck([{ lot, take: 5 }]);
    await count(truck.id, lot, 3);
    const done = await finishLoading(truck.id, ctx());
    expect([done.loaded, done.shortLoaded]).toEqual([3, 2]);
    expect((await boxRow(lot.boxes[4]!.id)).status).toBe('in_stock');
  });

  it('refuses over an UNCOUNTED one, naming it, rows untouched; the count door may finish anyway', async () => {
    const counted = await mkLot(5);
    const uncounted = await mkLot(2);
    await db
      .update(receiptLots)
      .set({ qrSkippedAt: new Date() })
      .where(inArray(receiptLots.id, [counted.lotId, uncounted.lotId]));
    const truck = await planTruck([
      { lot: counted, take: 5 },
      { lot: uncounted, take: 2 },
    ]);
    await count(truck.id, counted, 3);
    const refused = await finishLoading(truck.id, ctx()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ScanError);
    expect((refused as ScanError).code).toBe('qrless_uncounted');
    expect((refused as ScanError).detail?.lots).toHaveLength(1);
    expect((await boxRow(uncounted.boxes[0]!.id)).status).toBe('planned');
    expect((await boxRow(counted.boxes[4]!.id)).status).toBe('planned');
    const board = await qrlessUncountedByTruck(db, [truck.id]);
    expect(board.get(truck.id)?.map((l) => l.lotId)).toEqual([uncounted.lotId]);

    const done = await finishLoading(truck.id, ctx(), { dropQrless: true });
    expect([done.loaded, done.shortLoaded]).toEqual([3, 4]);
    expect((await boxRow(uncounted.boxes[0]!.id)).status).toBe('in_stock');
  });

  it('the summary names a counted lot’s cartons left behind as ONE line', async () => {
    const lot = await mkLot(4);
    const truck = await planTruck([{ lot, take: 4 }]);
    await count(truck.id, lot, 2);
    await finishLoading(truck.id, ctx());
    const [b] = await db.select({ code: batches.code }).from(batches).where(eq(batches.id, truck.id));
    const rows = await db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.type, 'LoadFinished'), sql`${notifications.payload}->>'text' LIKE ${`%${b!.code}%`}`));
    expect(rows.length).toBeGreaterThan(0);
    const text = String((rows[0]!.payload as { text: string }).text);
    expect(text).toMatch(/-[A-Z]+ ×2/);
    expect(text).not.toContain(lot.boxes[2]!.code);
  });
});

describe('the truck’s papers read what is ON it (decision 25)', () => {
  it('count 5, dial to 2, finish, depart: the packing list says 2, the register’s ➕ is distinct, a lot at 0 is absent', async () => {
    const lot = await mkLot(5);
    const zero = await mkLot(4);
    const spot = await mkLot(4);
    const truck = await planTruck([
      { lot, take: 5 },
      { lot: zero, take: 2 },
      { lot: spot, take: 2 },
    ]);
    await count(truck.id, lot, 5);
    await count(truck.id, lot, 2);
    await count(truck.id, zero, 2);
    await count(truck.id, zero, 0);
    // Two beyond the plan, one of them taken back off: the ➕ is ONE.
    await count(truck.id, spot, 4, { reason: 'bor edi' });
    await count(truck.id, spot, 3);
    await finishLoading(truck.id, ctx());
    await departBatch(truck.id, ctx());

    const buf = await buildPackingPhotosXlsx(truck.id);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf! as never);
    const sheet = wb.worksheets[0]!;
    const byCode = new Map<string, number>();
    sheet.eachRow((row, rowNo) => {
      if (rowNo <= 2) return; // the title and the header
      const code = String(row.getCell(1).value ?? '');
      const n = Number(row.getCell(3).value ?? 0);
      if (code.includes('-')) byCode.set(code, n);
    });
    const counts = [...byCode.values()].sort();
    expect(counts).toEqual([2, 3]);

    const members = await db.select({ id: boxes.id }).from(boxes).where(batchMemberFilter(truck.id));
    expect(members).toHaveLength(5);
    const register = await batchRegister([W.cn]);
    expect(register.find((r) => r.id === truck.id)?.added).toBe(1);
  });
});

describe('what the office sees', () => {
  it('the panel, the chip, and a lot dialled to 0 still the office’s', async () => {
    const lot = await mkLot(4);
    const truck = await planTruck([{ lot, take: 4 }]);
    await count(truck.id, lot, 3);
    let panel = await countLoadPanel({ id: truck.id, originWarehouseId: W.cn });
    let row = panel.rows.find((r) => r.lotId === lot.lotId)!;
    expect([row.plan, row.aboard, row.reserved, row.mode]).toEqual([4, 3, 1, 'counted']);
    expect(row.lastCount).not.toBeNull();
    expect(Number.isNaN(new Date(row.lastCount!.at).getTime())).toBe(false);
    expect(await countedOnTruck(truck.id)).toEqual({ cartons: 3, lotIds: [lot.lotId] });
    await count(truck.id, lot, 0);
    panel = await countLoadPanel({ id: truck.id, originWarehouseId: W.cn });
    row = panel.rows.find((r) => r.lotId === lot.lotId)!;
    expect([row.aboard, row.mode]).toEqual([0, 'counted']);
    const modes = await countOnlyLotsOnTruck(db, { batchId: truck.id, side: 'load', countedSide: 'load', quickOriginId: null });
    expect(modes.get(lot.lotId)).toBe('counted');
  });

  it('a press is one edit, never N scans, in the staff report', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
    const [me] = await db.select({ name: users.fullName }).from(users).where(eq(users.id, actorId));
    const mine = async () => (await staffActivity(1)).find((r) => r.name === me!.name && r.day === today);
    const lot = await mkLot(5);
    const truck = await planTruck([{ lot, take: 5 }]);
    const before = await mine();
    await count(truck.id, lot, 5);
    const after = await mine();
    expect(after!.scans).toBe(before?.scans ?? 0);
    expect(after!.edits).toBe((before?.edits ?? 0) + 1);
  });
});

describe('concurrency (decision 23) — deterministic, with a held-open second connection', () => {
  async function waiterPid(): Promise<number | null> {
    for (let i = 0; i < 250; i += 1) {
      const rows = await db.execute<{ pid: number }>(sql`
        SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
      `);
      if (rows[0]?.pid) return rows[0].pid;
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  }

  it('a press waits for a writer holding the truck, and counts from what it committed', async () => {
    const lot = await mkLot(5);
    const truck = await planTruck([{ lot, take: 5 }]);
    const helper = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', {
      max: 1,
      onnotice: () => {},
    });
    const held = await helper.reserve();
    try {
      await held`BEGIN`;
      await held`SELECT pg_advisory_xact_lock(hashtext('truck-load'), hashtext(${truck.id}::text))`;
      await held`UPDATE boxes SET status = 'loading' WHERE id = ${lot.boxes[0]!.id}`;
      await held`INSERT INTO scan_events (id, client_event_uuid, box_id, batch_id, type, method, manual_reason, scanned_by, scanned_at)
                 VALUES (${uuidv4()}, ${uuidv4()}, ${lot.boxes[0]!.id}, ${truck.id}, 'load', 'manual', 'count_load', ${actorId}, now())`;
      const running = count(truck.id, lot, 3, { seen: 1 });
      const settled = running.then(
        (r) => r,
        (e: unknown) => e,
      );
      expect(await waiterPid(), 'the press never waited').not.toBeNull();
      await held`COMMIT`;
      const res = await settled;
      expect(res).toMatchObject({ before: 1, aboard: 3, added: 2 });
    } finally {
      held.release();
      await helper.end();
    }
  });

  it('a phone that got there first makes the press stale, never a mixed guess', async () => {
    const lot = await mkLot(4);
    const truck = await planTruck([{ lot, take: 3 }]);
    const sibling = lot.boxes[3]!;
    const helper = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', {
      max: 1,
      onnotice: () => {},
    });
    const held = await helper.reserve();
    try {
      await held`BEGIN`;
      await held`SELECT id FROM boxes WHERE id = ${sibling.id} FOR UPDATE`;
      await held`UPDATE boxes SET status = 'loading', current_batch_id = ${truck.id}, flags = '["added_on_spot"]'::jsonb
                 WHERE id = ${sibling.id}`;
      await held`INSERT INTO scan_events (id, client_event_uuid, box_id, batch_id, type, method, added_on_spot, scanned_by, scanned_at)
                 VALUES (${uuidv4()}, ${uuidv4()}, ${sibling.id}, ${truck.id}, 'load', 'qr', true, ${actorId}, now())`;
      const running = count(truck.id, lot, 3, { seen: 0 });
      const settled = running.then(
        (r) => r,
        (e: unknown) => e,
      );
      expect(await waiterPid(), 'the press never waited').not.toBeNull();
      await held`COMMIT`;
      const res = await settled;
      expect(res).toBeInstanceOf(CountError);
      expect([(res as CountError).code, (res as CountError).detail.current]).toEqual(['count_stale', 1]);
    } finally {
      held.release();
      await helper.end();
    }
  });
});

describe('a 500-carton press', () => {
  it('lands in one transaction, and is measured', async () => {
    const lot = await mkLot(500);
    const truck = await quickTruck(W.cn, W.uz);
    const t0 = performance.now();
    const res = await count(truck.id, lot, 500);
    const ms = Math.round(performance.now() - t0);
    console.info(`[count-load] 500-carton press: ${ms} ms`);
    expect(res.aboard).toBe(500);
    const t1 = performance.now();
    await count(truck.id, lot, 0);
    console.info(`[count-load] 500-carton dial to 0: ${Math.round(performance.now() - t1)} ms`);
  }, 120_000);
});
