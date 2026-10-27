import 'dotenv/config';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  batches,
  boxes,
  boxMovements,
  clientNotices,
  clients,
  events,
  notifications,
  planLineRoad,
  planRoadClaims,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { PlanError, recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { anyRoadOwedFor, lotSplitAt, planRoadReady, roadOwedForTruck } from '@/modules/wms/planning/road';
import { plannableStock, roadStock, withRoad } from '@/modules/wms/planning/stock';
import { batchRegister } from '@/modules/wms/reports/queries';
import { departBatch, finishLoading, ingestLoadScans, ScanError } from '@/modules/wms/scanning/service';
import { ingestUnloadScans, unloadRemaining } from '@/modules/wms/scanning/unload';
import { countDoorFor } from '@/modules/wms/scanning/count-door';
import { countLoadLot, countLoadPanel } from '@/modules/wms/scanning/count-load';
import { acceptFoundBox } from '@/modules/wms/inventory/service';

/**
 * Yo'ldagi yuk (docs/YOLDAGI-YUK.md; the owner's 1a 2a 3a 4a 5a, 2026-10-27):
 * a plan at Horgos may take cartons still on a truck from Yiwu, the approval
 * reserves the shelf and OWES the rest, the landing reserves the owed cartons
 * onto the truck in its own transaction, and «yuklash tugadi» keeps what did
 * not come as MISSED. Through the real services, end to end.
 *
 * Its own warehouses — a Chinese origin (Yiwu's shape), a Chinese hub
 * (Horgos's), a Chinese destination for the onward trucks, and an Uzbek
 * collection warehouse for the notice case — DEACTIVATED at the end, never
 * deleted (audit_log FK). The cargo stays: a truck's history is data (#183).
 */

const S = String(Date.now()).slice(-6);
let actorId: string;
const W = { yw: '', hor: '', ka: '', and: '', tas: '' };
const madeClients: string[] = [];
const madeBatches: string[] = [];
const ctx = () => ({ actorId });

async function mintWarehouse(code: string, type: string, country: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, batchPrefix: code, name: `Yo'l ${code}`, country, type, timezone: 'Asia/Shanghai' })
    .returning({ id: warehouses.id });
  return row!.id;
}

let seq = 0;
async function mkLot(warehouseId: string, boxCount: number) {
  seq += 1;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `YR${seq}${S}`.slice(0, 10), name: `Yo'l ${seq} ${S}` })
    .returning({ id: clients.id });
  madeClients.push(client!.id);
  const lotId = uuidv4();
  const receiptId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `road/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId,
      clientId: client!.id,
      dealId: null,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '路上的货',
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
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId)).orderBy(asc(boxes.seqInLot));
  return { lotId, receiptId, clientId: client!.id, boxes: rows.map((b) => ({ id: b.id, code: b.shortCode })) };
}
type Lot = Awaited<ReturnType<typeof mkLot>>;

const qr = (batchId: string, code: string) => ({
  clientEventUuid: uuidv4(),
  batchId,
  code,
  method: 'qr' as const,
  addedOnSpot: false,
  scannedAt: new Date().toISOString(),
});

async function submit(origin: string, dest: string, lines: { lot: Lot; take: number }[], road: boolean) {
  return submitPlan(
    {
      originWarehouseId: origin,
      destWarehouseId: dest,
      lines: lines.map((l) => ({ lotId: l.lot.lotId, boxCount: l.take })),
      road,
    } as never,
    ctx(),
  );
}

async function approve(versionId: string) {
  const { batch } = await recordVerdict({ versionId, verdict: 'approved' } as never, ctx());
  madeBatches.push(batch!.id);
  return batch!;
}

/**
 * A truck from `origin` to `dest` carrying `take` of `lot` (all by default),
 * loaded and departed — the road. The approval reserves the lowest numbers
 * first, so the cartons it carries are the next `take` still on the shelf.
 */
async function roadTruck(origin: string, dest: string, lot: Lot, take = lot.boxes.length, skip = 0) {
  const sub = await submit(origin, dest, [{ lot, take }], false);
  const truck = await approve(sub.version.id);
  const acks = await ingestLoadScans(lot.boxes.slice(skip, skip + take).map((b) => qr(truck.id, b.code)), ctx());
  expect(acks.every((a) => a.result === 'ok')).toBe(true);
  await finishLoading(truck.id, ctx());
  await departBatch(truck.id, ctx());
  return truck;
}

/** «seq:status» per carton, `@O` / `@I` while it points at the named truck. */
async function statusOf(lot: Lot, trucks: Record<string, string> = {}) {
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lot.lotId)).orderBy(asc(boxes.seqInLot));
  const name = new Map(Object.entries(trucks).map(([k, v]) => [v, k]));
  return rows.map(
    (b) => `${b.seqInLot}:${b.status}${b.currentBatchId ? `@${name.get(b.currentBatchId) ?? '?'}` : ''}`,
  );
}

async function roadRow(versionId: string, lot: Lot) {
  const rows = await db.execute(sql`
    SELECT plr.road_box_count, plr.road_owed, plr.road_missed FROM plan_line_road plr
      JOIN load_plan_lines pl ON pl.id = plr.line_id
     WHERE pl.version_id = ${versionId}::uuid AND pl.lot_id = ${lot.lotId}::uuid`);
  const r = (rows as unknown as { road_box_count: number; road_owed: number; road_missed: number }[])[0];
  return r ? { part: Number(r.road_box_count), owed: Number(r.road_owed), missed: Number(r.road_missed) } : null;
}

const office = (warehouseId: string) =>
  countDoorFor({ id: actorId, permissions: new Set(['plans.manage']), warehouseScoped: false, warehouseIds: [] }, warehouseId)!;

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  W.yw = await mintWarehouse(`RYW${S}`, 'origin', 'CN');
  W.hor = await mintWarehouse(`RHO${S}`, 'hub', 'CN');
  W.ka = await mintWarehouse(`RKA${S}`, 'hub', 'CN');
  W.and = await mintWarehouse(`RAN${S}`, 'customs', 'UZ');
  W.tas = await mintWarehouse(`RTA${S}`, 'distribution', 'UZ');
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
  if (madeClients.length) await db.delete(clientNotices).where(inArray(clientNotices.clientId, madeClients));
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(W)));
  await pgClient.end();
});

describe('the submit splits each line shelf first, and the road answers only with the box ticked', () => {
  it('takes shelf + road, records the road part, and refuses beyond it', async () => {
    const onRoad = await mkLot(W.yw, 6);
    await roadTruck(W.yw, W.hor, onRoad);
    const shelf = await mkLot(W.hor, 2);
    const split = await lotSplitAt(db, W.hor, [onRoad.lotId, shelf.lotId]);
    expect(split.get(onRoad.lotId)).toMatchObject({ shelf: 0, road: 6, owed: 0, roadFree: 6 });
    expect(split.get(shelf.lotId)).toMatchObject({ shelf: 2, road: 0 });

    // Unticked: the road is invisible, exactly as before.
    await expect(submit(W.hor, W.ka, [{ lot: onRoad, take: 4 }], false)).rejects.toMatchObject({
      code: 'insufficient_stock',
    });
    // Ticked: shelf first — a shelf lot has no road part, a road lot is all road.
    const sub = await submit(W.hor, W.ka, [{ lot: onRoad, take: 4 }, { lot: shelf, take: 2 }], true);
    expect(await roadRow(sub.version.id, onRoad)).toEqual({ part: 4, owed: 0, missed: 0 });
    expect(await roadRow(sub.version.id, shelf)).toBeNull();
    // More than shelf + road: refused with the number that IS there.
    await expect(submit(W.hor, W.ka, [{ lot: onRoad, take: 7 }], true)).rejects.toMatchObject({
      code: 'insufficient_stock',
      detail: `${onRoad.lotId}:6`,
    });
  });
});

describe('the approval reserves the shelf and owes the road; the landing reserves what it owes', () => {
  it('lands the owed cartons onto the truck in the landing itself, and leaves the rest free', async () => {
    const lot = await mkLot(W.yw, 6);
    const inbound = await roadTruck(W.yw, W.hor, lot);
    const sub = await submit(W.hor, W.ka, [{ lot, take: 4 }], true);
    const truck = await approve(sub.version.id);
    expect(await roadRow(sub.version.id, lot)).toEqual({ part: 4, owed: 4, missed: 0 });
    const T = { I: inbound.id, O: truck.id };
    expect(await statusOf(lot, T)).toEqual(Array.from({ length: 6 }, (_, i) => `${i + 1}:in_transit@I`));

    // Three land by phone: all three are the plan's at once.
    const acks = await ingestUnloadScans(lot.boxes.slice(0, 3).map((b) => qr(inbound.id, b.code)), ctx());
    expect(acks.map((a) => a.result)).toEqual(['ok', 'ok', 'ok']);
    expect((await statusOf(lot, T)).slice(0, 3)).toEqual(['1:planned@O', '2:planned@O', '3:planned@O']);
    expect(await roadRow(sub.version.id, lot)).toEqual({ part: 4, owed: 1, missed: 0 });
    // The reservation is the approval's shape: from = to = the shelf, its status recorded.
    const reserved = await db
      .select({ from: boxMovements.fromStatus, to: boxMovements.toStatus, fromWh: boxMovements.fromWarehouseId })
      .from(boxMovements)
      .where(
        and(
          eq(boxMovements.refId, truck.id),
          eq(boxMovements.cause, 'plan_approved'),
          inArray(boxMovements.boxId, lot.boxes.slice(0, 3).map((b) => b.id)),
        ),
      );
    expect(reserved).toEqual(Array(3).fill({ from: 'in_stock', to: 'planned', fromWh: W.hor }));
    const claims = await db
      .select({ inbound: planRoadClaims.inboundBatchId })
      .from(planRoadClaims)
      .where(inArray(planRoadClaims.boxId, lot.boxes.slice(0, 3).map((b) => b.id)));
    expect(claims).toEqual(Array(3).fill({ inbound: inbound.id }));

    // The rest of the truck: one more is owed, two are nobody's.
    await unloadRemaining(inbound.id, ctx());
    expect((await statusOf(lot, T)).slice(3)).toEqual(['4:planned@O', '5:in_stock', '6:in_stock']);
    expect(await roadRow(sub.version.id, lot)).toEqual({ part: 4, owed: 0, missed: 0 });
  });

  it('a stale scan of a carton this truck already landed is a duplicate — never a rogue un-reservation', async () => {
    const lot = await mkLot(W.yw, 2);
    const inbound = await roadTruck(W.yw, W.hor, lot);
    const sub = await submit(W.hor, W.ka, [{ lot, take: 2 }], true);
    const truck = await approve(sub.version.id);
    await unloadRemaining(inbound.id, ctx());
    const T = { I: inbound.id, O: truck.id };
    expect(await statusOf(lot, T)).toEqual(['1:planned@O', '2:planned@O']);
    // The phone that scanned carton 1 offline comes back online with a new event id.
    const [stale] = await ingestUnloadScans([qr(inbound.id, lot.boxes[0]!.code)], ctx());
    expect(stale!.result).toBe('duplicate');
    expect(await statusOf(lot, T)).toEqual(['1:planned@O', '2:planned@O']);
    const flags = await db.select({ flags: boxes.flags }).from(boxes).where(eq(boxes.id, lot.boxes[0]!.id));
    expect(flags[0]!.flags).toEqual([]);
  });

  it('a road part the road can no longer give is refused at the approval, not owed for ever', async () => {
    const lot = await mkLot(W.yw, 3);
    await roadTruck(W.yw, W.hor, lot);
    const first = await submit(W.hor, W.ka, [{ lot, take: 3 }], true);
    const second = await submit(W.hor, W.ka, [{ lot, take: 2 }], true);
    await approve(first.version.id);
    // The first approval owes all three; the road holds three.
    await expect(
      recordVerdict({ versionId: second.version.id, verdict: 'approved' } as never, ctx()),
    ).rejects.toMatchObject({ code: 'insufficient_stock' });
  });

  it('two presses of one approval make one truck', async () => {
    const lot = await mkLot(W.yw, 2);
    await roadTruck(W.yw, W.hor, lot);
    const sub = await submit(W.hor, W.ka, [{ lot, take: 2 }], true);
    const both = await Promise.allSettled([
      recordVerdict({ versionId: sub.version.id, verdict: 'approved' } as never, ctx()),
      recordVerdict({ versionId: sub.version.id, verdict: 'approved' } as never, ctx()),
    ]);
    const won = both.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const lost = both.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(PlanError);
    expect((lost.reason as PlanError).code).toBe('verdict_already_recorded');
    madeBatches.push((won[0] as PromiseFulfilledResult<{ batch: { id: string } }>).value.batch.id);
  });
});

describe('the loading ends without the road part (4a)', () => {
  it('«yuklash tugadi» keeps it as missed, a later landing claims nothing, and the count door asks only for the shelf', async () => {
    // Two of the lot already landed here, three still on the road.
    const lot = await mkLot(W.yw, 5);
    const first = await roadTruck(W.yw, W.hor, lot, 2, 0);
    await unloadRemaining(first.id, ctx());
    const inbound = await roadTruck(W.yw, W.hor, lot, 3, 2);
    const sub = await submit(W.hor, W.ka, [{ lot, take: 5 }], true);
    const truck = await approve(sub.version.id);
    expect(await roadRow(sub.version.id, lot)).toEqual({ part: 3, owed: 3, missed: 0 });
    // The count door's number is what can be on the truck: the two here.
    const before = await countLoadPanel({ id: truck.id, originWarehouseId: W.hor });
    expect(before.rows.find((r) => r.lotId === lot.lotId)?.plan).toBe(2);
    // Departing with the road part still owed is refused — «yuklash tugadi» first.
    await ingestLoadScans(lot.boxes.slice(0, 2).map((b) => qr(truck.id, b.code)), ctx());
    await expect(departBatch(truck.id, ctx())).rejects.toMatchObject({ code: 'road_owed_open' });

    expect(await anyRoadOwedFor(db, await planRoadReady(), [lot.lotId])).toBe(true);
    const done = await finishLoading(truck.id, ctx());
    expect(done.roadMissed).toBe(3);
    expect(await roadRow(sub.version.id, lot)).toEqual({ part: 3, owed: 0, missed: 3 });
    // Nothing owed any more: the annul's refusal lifts.
    expect(await anyRoadOwedFor(db, await planRoadReady(), [lot.lotId])).toBe(false);
    // The register's ⤵️ counts the road part that never came (4a: short as today).
    const register = await batchRegister([W.hor]);
    expect(Number(register.find((r) => r.id === truck.id)?.short)).toBe(3);

    // After the finish the count door still asks for the two — never the five,
    // which would grow the lot by three cartons that later land as duplicates.
    const after = await countLoadPanel({ id: truck.id, originWarehouseId: W.hor });
    expect(after.rows.find((r) => r.lotId === lot.lotId)?.plan).toBe(2);

    // The road cargo lands after the finish: nobody owes it, it stays free.
    await unloadRemaining(inbound.id, ctx());
    const T = { I: inbound.id, O: truck.id };
    expect((await statusOf(lot, T)).slice(2)).toEqual(['3:in_stock', '4:in_stock', '5:in_stock']);
    await departBatch(truck.id, ctx());
  });
});

describe('cargo already here is claimed when it is loaded (self-healing)', () => {
  it('the phone loads a free carton of an owed lot as plan cargo, and refuses one still on the road in words', async () => {
    const lot = await mkLot(W.yw, 3);
    const inbound = await roadTruck(W.yw, W.hor, lot);
    const sub = await submit(W.hor, W.ka, [{ lot, take: 3 }], true);
    const truck = await approve(sub.version.id);
    // A carton reaches the shelf by a door the hook never saw (a hand fix).
    await db
      .update(boxes)
      .set({ status: 'in_stock', currentBatchId: null, currentWarehouseId: W.hor })
      .where(eq(boxes.id, lot.boxes[0]!.id));

    const [claimed] = await ingestLoadScans([qr(truck.id, lot.boxes[0]!.code)], ctx());
    expect(claimed!.result).toBe('ok');
    const T = { I: inbound.id, O: truck.id };
    expect((await statusOf(lot, T))[0]).toBe('1:loading@O');
    expect(await roadRow(sub.version.id, lot)).toEqual({ part: 3, owed: 2, missed: 0 });

    const [onRoad] = await ingestLoadScans([qr(truck.id, lot.boxes[1]!.code)], ctx());
    expect(onRoad).toMatchObject({ result: 'rejected', detail: 'road_not_landed', inboundCode: inbound.code });
    expect((await statusOf(lot, T))[1]).toBe('2:in_transit@I');
  });

  it('the count door claims what stands free before it computes — no over-reason for plan cargo', async () => {
    const lot = await mkLot(W.yw, 4);
    await roadTruck(W.yw, W.hor, lot);
    const sub = await submit(W.hor, W.ka, [{ lot, take: 4 }], true);
    const truck = await approve(sub.version.id);
    // Two found in the yard by the single found door.
    for (const box of lot.boxes.slice(0, 2)) {
      await expect(acceptFoundBox({ warehouseId: W.hor, code: box.code }, ctx())).rejects.toMatchObject({
        code: 'use_unload_screen',
      });
    }
    await db
      .update(boxes)
      .set({ status: 'in_stock', currentBatchId: null, currentWarehouseId: W.hor })
      .where(inArray(boxes.id, lot.boxes.slice(0, 2).map((b) => b.id)));
    const res = await countLoadLot(
      { batchId: truck.id, lotId: lot.lotId, target: 2, seenAboard: 0, pressId: uuidv4() },
      ctx(),
      office(W.hor),
    );
    expect(res).toMatchObject({ aboard: 2, over: 0, grown: 0 });
    expect(await roadRow(sub.version.id, lot)).toEqual({ part: 4, owed: 2, missed: 0 });
  });
});

describe('a collection warehouse re-announces what it gives back', () => {
  it('a claimed carton given back «tayyor» re-arms the arrival notice of the truck it landed off', async () => {
    const lot = await mkLot(W.yw, 2);
    const inbound = await roadTruck(W.yw, W.and, lot);
    const sub = await submit(W.and, W.tas, [{ lot, take: 2 }], true);
    const truck = await approve(sub.version.id);
    await unloadRemaining(inbound.id, ctx());
    const T = { I: inbound.id, O: truck.id };
    expect(await statusOf(lot, T)).toEqual(['1:planned@O', '2:planned@O']);
    // The landing's notice has already spoken (about nothing ready).
    await db
      .update(clientNotices)
      .set({ status: 'skipped', staffNotifiedAt: new Date() })
      .where(and(eq(clientNotices.clientId, lot.clientId), eq(clientNotices.refId, inbound.id)));

    await finishLoading(truck.id, ctx());
    expect(await statusOf(lot, T)).toEqual(['1:ready_for_pickup', '2:ready_for_pickup']);
    const [notice] = await db
      .select({ status: clientNotices.status, staff: clientNotices.staffNotifiedAt })
      .from(clientNotices)
      .where(and(eq(clientNotices.clientId, lot.clientId), eq(clientNotices.refId, inbound.id)));
    expect(notice).toEqual({ status: 'pending', staff: null });
  });
});

describe('the readers say the road part', () => {
  it('the editor’s road half lists a road-only lot in the shelf list’s own shape, with its truck', async () => {
    const lot = await mkLot(W.yw, 5);
    const inbound = await roadTruck(W.yw, W.hor, lot);
    const road = await roadStock(W.hor);
    const row = road.lots.find((l) => l.lotId === lot.lotId)!;
    expect(row).toMatchObject({ available: 0, productNameZh: '路上的货', daysInStock: null });
    expect(row.road.free).toBe(5);
    expect(row.road.trucks.map((t) => t.code)).toEqual([inbound.code]);
    expect(row.perBoxKg).toBe(10);
    // ONE list: the road-only lot joins the shelf's.
    const merged = withRoad((await plannableStock(W.hor)).lots, road.lots);
    expect(merged.filter((l) => l.lotId === lot.lotId)).toHaveLength(1);
    // An approved plan owing three leaves two free on the road for the next.
    const sub = await submit(W.hor, W.ka, [{ lot, take: 3 }], true);
    await approve(sub.version.id);
    expect((await roadStock(W.hor)).lots.find((l) => l.lotId === lot.lotId)!.road.free).toBe(2);
  });

  it('the loading snapshot names what is owed, on which truck, and ships the codes a scan would claim', async () => {
    const lot = await mkLot(W.yw, 3);
    const inbound = await roadTruck(W.yw, W.hor, lot);
    const sub = await submit(W.hor, W.ka, [{ lot, take: 3 }], true);
    const truck = await approve(sub.version.id);
    const snap = await roadOwedForTruck(db, await planRoadReady(), truck.id, W.hor);
    expect(snap.lots).toEqual([
      expect.objectContaining({ lotId: lot.lotId, owed: 3, trucks: [inbound.code] }),
    ]);
    expect([...snap.codes].sort()).toEqual(lot.boxes.map((b) => b.code).sort());
  });

  it('the agent sheet files the road part under «В пути» and the landed part under its truck', async () => {
    const lot = await mkLot(W.yw, 6);
    const first = await roadTruck(W.yw, W.hor, lot, 4, 0);
    await unloadRemaining(first.id, ctx());
    const second = await roadTruck(W.yw, W.hor, lot, 2, 4);
    const sub = await submit(W.hor, W.ka, [{ lot, take: 6 }], true);
    expect(await roadRow(sub.version.id, lot)).toEqual({ part: 2, owed: 0, missed: 0 });
    const { buildAgentXlsx } = await import('@/modules/wms/documents/agent-xlsx');
    const ExcelJS = (await import('exceljs')).default;
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await buildAgentXlsx(sub.plan.id, sub.version.versionNo))! as unknown as ArrayBuffer);
    const sheet = book.worksheets[0]!;
    const cells: string[][] = [];
    sheet.eachRow((row) => cells.push((row.values as unknown[]).slice(1).map((v) => String(v ?? ''))));
    const roadHeading = cells.findIndex((r) => r[0]!.startsWith('В пути / On the road'));
    expect(roadHeading).toBeGreaterThan(0);
    expect(cells[roadHeading]![0]).toContain(second.code);
    expect(cells[roadHeading]![0]).toContain('2 Коробок');
    // Under it, the lot's road part alone — two cartons, the truck named in the row.
    expect(cells[roadHeading + 1]![3]).toBe('2');
    expect(cells[roadHeading + 1]![7]).toContain(second.code);
    // And the landed four under the truck that brought them, never «received here».
    const landed = cells.findIndex((r) => r[0]!.includes(first.code) && r[0]!.startsWith('Партия прихода'));
    expect(landed).toBeGreaterThan(0);
    expect(cells[landed + 1]![3]).toBe('4');
  });
});

describe('nothing outside the round moves', () => {
  it('a plan with the box unticked writes no road row at all', async () => {
    const lot = await mkLot(W.hor, 2);
    const sub = await submit(W.hor, W.ka, [{ lot, take: 2 }], false);
    const rows = await db
      .select({ id: planLineRoad.lineId })
      .from(planLineRoad)
      .where(sql`${planLineRoad.lineId} IN (SELECT id FROM load_plan_lines WHERE version_id = ${sub.version.id}::uuid)`);
    expect(rows).toEqual([]);
    expect(ScanError).toBeDefined();
  });
});
