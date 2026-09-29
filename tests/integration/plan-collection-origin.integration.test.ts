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
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { createCrate } from '@/modules/wms/crates/service';
import { availableByLot, recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { plannableStock } from '@/modules/wms/planning/stock';
import {
  departBatch,
  finishLoading,
  ingestLoadScans,
  removeLoadedCode,
} from '@/modules/wms/scanning/service';
import {
  cancelBatch,
  finishUnload,
  ingestUnloadScans,
  resolveMissing,
} from '@/modules/wms/scanning/unload';
import { countDoorFor } from '@/modules/wms/scanning/count-door';
import { countLoadLot } from '@/modules/wms/scanning/count-load';
import { countAcceptLot } from '@/modules/wms/scanning/count-accept';

/**
 * «Andijondan Toshkentga ichki reys» (owner, 2026-09-28: «yuklarni partiya
 * qilib andijon skladga olib keldim endi men ularni ichki reys qilib
 * toshkentga olib kelaman desam sklatda yuk korinmay qolyabti»).
 *
 * A truck unloaded at a warehouse the client collects from leaves its cargo
 * `ready_for_pickup`, and the plan path read `in_stock` alone — the editor
 * offered nothing, the submit and the approval would have refused it. Every
 * door that gives cargo BACK wrote a bare `in_stock` too, which at Andijan
 * takes a carton off every «tayyor» list. Through the real services: the
 * editor's list, the submit, the approval, «yuklash tugadi», the loader's
 * removal, a cancelled truck, the unload end's «found at the origin», and the
 * office's count re-reserving what the plan counted.
 *
 * Its own two Uzbek warehouses — a customs one as the origin (Andijan's
 * shape) and a distribution one as the destination (Tashkent's) —
 * DEACTIVATED at the end, never deleted (audit_log FK). The cargo stays: a
 * truck's history is data, not configuration (#183).
 */

const S = String(Date.now()).slice(-6);
let actorId: string;
const W = { and: '', tas: '' };
const madeClients: string[] = [];
const madeBatches: string[] = [];
const ctx = () => ({ actorId });

async function mintWarehouse(code: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, batchPrefix: code, name: `Ichki ${code}`, country: 'UZ', type, timezone: 'Asia/Tashkent' })
    .returning({ id: warehouses.id });
  return row!.id;
}

let seq = 0;
/**
 * A prixod at the origin. `landed` = what a truck's unload leaves at a
 * collection warehouse (`ready_for_pickup`); otherwise it stays as received
 * there (`in_stock`, a walk-in).
 */
async function mkLot(boxCount: number, landed: boolean) {
  seq += 1;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `IR${seq}${S}`.slice(0, 10), name: `Ichki reys ${seq} ${S}` })
    .returning({ id: clients.id });
  madeClients.push(client!.id);
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `ichki/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId: uuidv4(),
      warehouseId: W.and,
      clientId: client!.id,
      dealId: null,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '内部运输',
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
  if (landed) await db.update(boxes).set({ status: 'ready_for_pickup' }).where(eq(boxes.lotId, lotId));
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId)).orderBy(asc(boxes.seqInLot));
  return { lotId, boxes: rows.map((b) => ({ id: b.id, code: b.shortCode })) };
}
type Lot = Awaited<ReturnType<typeof mkLot>>;

async function planTruck(lines: { lot: Lot; take: number }[], crateIds: string[] = []) {
  const sub = await submitPlan(
    {
      originWarehouseId: W.and,
      destWarehouseId: W.tas,
      lines: lines.map((l) => ({ lotId: l.lot.lotId, boxCount: l.take })),
      crateIds,
    } as never,
    ctx(),
  );
  const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' } as never, ctx());
  madeBatches.push(batch!.id);
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

/** The office's count door at a warehouse. */
const office = (warehouseId: string) =>
  countDoorFor({ id: actorId, permissions: new Set(['plans.manage']), warehouseScoped: false, warehouseIds: [] }, warehouseId)!;

/** «seq:status» per carton, `@T` while it points at a truck. */
async function statusOf(lot: Lot) {
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lot.lotId)).orderBy(asc(boxes.seqInLot));
  return rows.map((b) => `${b.seqInLot}:${b.status}${b.currentBatchId ? '@T' : ''}`);
}

/** The movements a cause wrote on a truck, as «seq:from→to». */
async function moves(batchId: string, lot: Lot, cause: string) {
  const rows = await db
    .select({ id: boxMovements.boxId, from: boxMovements.fromStatus, to: boxMovements.toStatus })
    .from(boxMovements)
    .where(
      and(
        eq(boxMovements.refId, batchId),
        eq(boxMovements.cause, cause),
        inArray(boxMovements.boxId, lot.boxes.map((b) => b.id)),
      ),
    );
  const seqOf = new Map(lot.boxes.map((b, i) => [b.id, i + 1]));
  return rows.map((r) => `${seqOf.get(r.id)}:${r.from}→${r.to}`).sort();
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  W.and = await mintWarehouse(`IRA${S}`, 'customs');
  W.tas = await mintWarehouse(`IRT${S}`, 'distribution');
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
  // The arrival claims the Tashkent landing made: a pending one is the next
  // file's drain input (#154).
  if (madeClients.length) await db.delete(clientNotices).where(inArray(clientNotices.clientId, madeClients));
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(W)));
  await pgClient.end();
});

describe('the plan editor sees what a truck landed at Andijan', () => {
  it('lists «tayyor» cargo beside a walk-in, and the submit counts both', async () => {
    const landed = await mkLot(4, true);
    const walkIn = await mkLot(2, false);
    const stock = await plannableStock(W.and);
    const listed = new Map(stock.lots.map((l) => [l.lotId, l.available]));
    expect(listed.get(landed.lotId)).toBe(4);
    expect(listed.get(walkIn.lotId)).toBe(2);
    const free = await availableByLot(W.and, [landed.lotId, walkIn.lotId]);
    expect([free.get(landed.lotId), free.get(walkIn.lotId)]).toEqual([4, 2]);
  });

  it('a yashik that landed there is offered, and planned, as one place', async () => {
    const lot = await mkLot(3, false);
    const crateId = uuidv4();
    await createCrate(
      { crateId, warehouseId: W.and, boxIds: lot.boxes.map((b) => b.id), kind: 'yashik', logistApproved: true } as never,
      ctx(),
    );
    // Packed in China, landed here: its cartons stand «tayyor» like the rest.
    await db.update(boxes).set({ status: 'ready_for_pickup' }).where(eq(boxes.lotId, lot.lotId));
    const stock = await plannableStock(W.and);
    expect(stock.crates.find((c) => c.crateId === crateId)?.boxCount).toBe(3);
    const truck = await planTruck([], [crateId]);
    expect(await statusOf(lot)).toEqual(['1:planned@T', '2:planned@T', '3:planned@T']);
    await cancelBatch(truck.id, 'sinov reysi', ctx());
    expect(await statusOf(lot)).toEqual(['1:ready_for_pickup', '2:ready_for_pickup', '3:ready_for_pickup']);
  });
});

describe('every door that gives cargo back gives it back as it stood', () => {
  it('the approval takes «tayyor» cargo, and «yuklash tugadi» returns it «tayyor»', async () => {
    const landed = await mkLot(4, true);
    const walkIn = await mkLot(2, false);
    const truck = await planTruck([
      { lot: landed, take: 3 },
      { lot: walkIn, take: 2 },
    ]);
    expect(await statusOf(landed)).toEqual(['1:planned@T', '2:planned@T', '3:planned@T', '4:ready_for_pickup']);
    // The reservation records where each one stood — the fact every give-back reads.
    expect(await moves(truck.id, landed, 'plan_approved')).toEqual([
      '1:ready_for_pickup→planned',
      '2:ready_for_pickup→planned',
      '3:ready_for_pickup→planned',
    ]);

    const [ack] = await ingestLoadScans([qr(truck.id, landed.boxes[0]!.code)], ctx());
    expect(ack!.result).toBe('ok');
    await finishLoading(truck.id, ctx());
    expect(await statusOf(landed)).toEqual([
      '1:loading@T',
      '2:ready_for_pickup',
      '3:ready_for_pickup',
      '4:ready_for_pickup',
    ]);
    // A walk-in goes back as the walk-in it was — the HISTORY decides, not
    // the warehouse's type.
    expect(await statusOf(walkIn)).toEqual(['1:in_stock', '2:in_stock']);
    expect(await moves(truck.id, landed, 'short_loaded')).toEqual([
      '2:planned→ready_for_pickup',
      '3:planned→ready_for_pickup',
    ]);

    // The plan still says 3: the office counting them back on re-reserves
    // them plain — no reason asked, no ⚠ (review cargo-6's extra is gone).
    const res = await countLoadLot(
      { batchId: truck.id, lotId: landed.lotId, target: 3, seenAboard: 1, pressId: uuidv4(), overReason: '' },
      ctx(),
      office(W.and),
    );
    expect([res.aboard, res.over]).toEqual([3, 0]);
    expect(await moves(truck.id, landed, 'plan_approved')).toEqual([
      '1:ready_for_pickup→planned',
      '2:ready_for_pickup→planned',
      '2:ready_for_pickup→planned',
      '3:ready_for_pickup→planned',
      '3:ready_for_pickup→planned',
    ]);
  });

  it('a carton the loader takes back off goes back «tayyor»', async () => {
    const landed = await mkLot(2, true);
    const truck = await planTruck([{ lot: landed, take: 2 }]);
    await ingestLoadScans([qr(truck.id, landed.boxes[0]!.code)], ctx());
    await removeLoadedCode(truck.id, landed.boxes[0]!.code, ctx());
    expect(await statusOf(landed)).toEqual(['1:ready_for_pickup', '2:planned@T']);
    expect(await moves(truck.id, landed, 'load_removed')).toEqual(['1:loading→ready_for_pickup']);
  });

  it('a cancelled truck gives back what was reserved and what was aboard', async () => {
    const landed = await mkLot(3, true);
    const walkIn = await mkLot(1, false);
    const truck = await planTruck([
      { lot: landed, take: 3 },
      { lot: walkIn, take: 1 },
    ]);
    await ingestLoadScans([qr(truck.id, landed.boxes[0]!.code)], ctx());
    await cancelBatch(truck.id, 'reja bekor', ctx());
    expect(await statusOf(landed)).toEqual(['1:ready_for_pickup', '2:ready_for_pickup', '3:ready_for_pickup']);
    expect(await statusOf(walkIn)).toEqual(['1:in_stock']);
    expect(await moves(truck.id, landed, 'batch_cancelled')).toEqual([
      '1:loading→ready_for_pickup',
      '2:planned→ready_for_pickup',
      '3:planned→ready_for_pickup',
    ]);
  });

  it('a carton Tashkent never received, found back at Andijan, is «tayyor» there again', async () => {
    const landed = await mkLot(2, true);
    const truck = await planTruck([{ lot: landed, take: 2 }]);
    await ingestLoadScans(landed.boxes.map((b) => qr(truck.id, b.code)), ctx());
    await departBatch(truck.id, ctx());
    const [ack] = await ingestUnloadScans([qr(truck.id, landed.boxes[0]!.code)], ctx());
    expect(ack!.result).toBe('ok');
    await finishUnload(truck.id, ctx(), { mayCloseWithMissing: true });
    await resolveMissing({ boxId: landed.boxes[1]!.id, resolution: 'found_at_origin' }, ctx());
    const [back] = await db.select().from(boxes).where(eq(boxes.id, landed.boxes[1]!.id));
    expect([back!.status, back!.currentWarehouseId]).toEqual(['ready_for_pickup', W.and]);
    // And the one that did arrive landed by Tashkent's own rule.
    const [arrived] = await db.select().from(boxes).where(eq(boxes.id, landed.boxes[0]!.id));
    expect([arrived!.status, arrived!.currentWarehouseId]).toEqual(['ready_for_pickup', W.tas]);
  });

  it('cartons Tashkent counted off Andijan’s shelf, taken back, stand «tayyor» at Andijan again', async () => {
    const landed = await mkLot(4, true);
    const truck = await planTruck([{ lot: landed, take: 2 }]);
    await ingestLoadScans(landed.boxes.slice(0, 2).map((b) => qr(truck.id, b.code)), ctx());
    await finishLoading(truck.id, ctx());
    await departBatch(truck.id, ctx());
    // «4 keldi»: the 2 aboard plus the 2 the office takes off the origin's shelf.
    const doors = { dest: office(W.tas), origin: office(W.and) };
    const over = await countAcceptLot(
      { batchId: truck.id, lotId: landed.lotId, target: 4, seenArrived: 0, pressId: uuidv4(), overReason: 'ortiq keldi', confirmArrival: true },
      ctx(),
      doors,
    );
    expect([over.landed, over.over]).toEqual([4, 2]);
    const back = await countAcceptLot(
      { batchId: truck.id, lotId: landed.lotId, target: 2, seenArrived: 4, pressId: uuidv4(), overReason: 'xato yozilgan', confirmArrival: false },
      ctx(),
      doors,
    );
    expect(back.undone).toBe(2);
    const rows = await db.select().from(boxes).where(eq(boxes.lotId, landed.lotId)).orderBy(asc(boxes.seqInLot));
    expect(rows.map((b) => `${b.seqInLot}:${b.status}@${b.currentWarehouseId === W.and ? 'AND' : 'TAS'}`)).toEqual([
      '1:ready_for_pickup@TAS',
      '2:ready_for_pickup@TAS',
      '3:ready_for_pickup@AND',
      '4:ready_for_pickup@AND',
    ]);
    expect(await moves(truck.id, landed, 'found_at_origin')).toEqual([
      '3:ready_for_pickup→ready_for_pickup',
      '4:ready_for_pickup→ready_for_pickup',
    ]);
  });
});
