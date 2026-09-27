import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxes,
  clients,
  costAllocations,
  costTypes,
  receiptLots,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, finishLoading, ingestLoadScans } from '@/modules/wms/scanning/service';
import { countDoorFor } from '@/modules/wms/scanning/count-door';
import { countLoadLot } from '@/modules/wms/scanning/count-load';
import { addCostEntry, recomputeAll } from '@/modules/wms/costing/service';
import { setBoxStatus } from '@/modules/wms/boxes/status';
import { ingestUnloadScans } from '@/modules/wms/scanning/unload';
import { countAcceptLot } from '@/modules/wms/scanning/count-accept';
import { riderRowsSql } from '@/modules/wms/batches/riders';

/**
 * The money a count's growth must NOT move (0112, his Q3 = b; review money-2).
 *
 * A growth press adds `add` cartons of the lot's OWN per-box figure and
 * nothing else of the lot changes: the costing engine divides a lot's totals
 * by its `box_count`, and a carton voided on the box card leaves box_count
 * alone — so growing by the ACTIVE count re-weighed every carton of the lot,
 * the ones on an earlier, already-costed truck included, and
 * `recomputeForLot` moved that truck's freight between clients.
 *
 * Own warehouses, deactivated at the end (audit_log FK); cost entries on a
 * sentinel date nobody else uses, deleted at the end.
 */
const S = String(Date.now()).slice(-6);
let actorId: string;
const W = { cn: '', uz: '' };
let freightType = '';
const ctx = () => ({ actorId });

async function mintWarehouse(code: string, country: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, batchPrefix: code, name: `Count money ${code}`, country, type, timezone: 'Asia/Tashkent' })
    .returning({ id: warehouses.id });
  return row!.id;
}

let seq = 0;
async function mkLot(lot: Record<string, unknown>) {
  seq += 1;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `CM${seq}${S}`.slice(0, 10), name: `Count money ${seq} ${S}` })
    .returning({ id: clients.id });
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `count-money/${lotId}`,
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
      lots: [{ id: lotId, productNameZh: '钱货', ...lot }],
      extraCosts: [],
    } as never,
    ctx(),
  );
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId)).orderBy(boxes.seqInLot);
  return { lotId, receiptId, clientId: client!.id, boxes: rows.map((b) => ({ id: b.id, code: b.shortCode })) };
}

async function planTruck(lines: { lotId: string; take: number }[]) {
  const sub = await submitPlan(
    { originWarehouseId: W.cn, destWarehouseId: W.uz, lines: lines.map((l) => ({ lotId: l.lotId, boxCount: l.take })) } as never,
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

async function sharesByClient(entryId: string) {
  const rows = await db
    .select({ clientId: costAllocations.clientId, usd: sql<string>`sum(${costAllocations.amountUsd})` })
    .from(costAllocations)
    .where(eq(costAllocations.costEntryId, entryId))
    .groupBy(costAllocations.clientId);
  return new Map(rows.map((r) => [r.clientId, Math.round(Number(r.usd) * 100) / 100]));
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  freightType = (await db.select({ id: costTypes.id }).from(costTypes).where(eq(costTypes.code, 'freight')))[0]!.id;
  W.cn = await mintWarehouse(`CMC${S}`, 'CN', 'origin');
  W.uz = await mintWarehouse(`CMU${S}`, 'UZ', 'distribution');
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM cost_entries WHERE cost_date = '1638-02-02'`);
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(W)));
  await pgClient.end();
});

describe('a growth press on a mixed lot that once lost a carton on the box card', () => {
  it('adds its own cartons and leaves an EARLIER truck’s money where it was', async () => {
    // A: mixed lot, 10 cartons, 100 kg, 1 m³ (10 kg each). B: uniform 4 × 10 kg.
    const a = await mkLot({ boxCount: 10, dimsMode: 'mixed', totalWeightKg: 100, totalVolumeM3: 1 });
    const b = await mkLot({
      boxCount: 4,
      dimsMode: 'uniform',
      boxLengthCm: 50,
      boxWidthCm: 40,
      boxHeightCm: 30,
      boxWeightKg: 10,
    });
    // T0 carries 4 of A and 4 of B.
    const t0 = await planTruck([
      { lotId: a.lotId, take: 4 },
      { lotId: b.lotId, take: 4 },
    ]);
    const planned = await db
      .select({ code: boxes.shortCode })
      .from(boxes)
      .where(and(eq(boxes.currentBatchId, t0.id), eq(boxes.status, 'planned')));
    const acks = await ingestLoadScans(planned.map((p) => qr(t0.id, p.code)), ctx());
    expect(acks.every((x) => x.result === 'ok')).toBe(true);
    await finishLoading(t0.id, ctx());
    await departBatch(t0.id, ctx());
    await recomputeAll({ batchId: t0.id });
    const fr = await addCostEntry(
      {
        scope: 'batch',
        batchId: t0.id,
        costTypeId: freightType,
        amount: 100,
        currency: 'USD',
        costDate: '1638-02-02',
        allocationBasis: 'weight',
      } as never,
      ctx(),
    );
    const before = await sharesByClient(fr.id);
    expect(before.get(a.clientId)).toBe(50);

    // A manager voids one of A's shelf cartons on the box card («yaroqsiz»).
    const shelf = await db
      .select()
      .from(boxes)
      .where(and(eq(boxes.lotId, a.lotId), eq(boxes.status, 'in_stock')))
      .orderBy(boxes.seqInLot);
    await setBoxStatus({ boxId: shelf[5]!.id, to: 'void', reason: 'yaroqsiz karobka' }, ctx());
    const [afterVoid] = await db.select().from(receiptLots).where(eq(receiptLots.id, a.lotId));
    const mid = await sharesByClient(fr.id);

    // T1: plan the 5 remaining, the office counts 6 — one carton beyond the prixod.
    const t1 = await planTruck([{ lotId: a.lotId, take: 5 }]);
    const door = countDoorFor(
      { id: actorId, permissions: new Set(['plans.manage']), warehouseScoped: false, warehouseIds: [] },
      W.cn,
    )!;
    const res = await countLoadLot(
      { batchId: t1.id, lotId: a.lotId, target: 6, seenAboard: 0, pressId: uuidv4(), overReason: 'bitta ortiq' },
      ctx(),
      door,
    );
    expect(res.grown).toBe(1);
    const [grown] = await db.select().from(receiptLots).where(eq(receiptLots.id, a.lotId));
    // One carton of the lot's own 10 kg — not 100 × 10/9 spread over all ten.
    expect(afterVoid!.boxCount).toBe(10);
    expect(grown!.boxCount).toBe(11);
    expect(Number(grown!.totalWeightKg)).toBe(110);
    const after = await sharesByClient(fr.id);
    // A growth of ONE carton on T1 must not move T0's money.
    expect(after.get(a.clientId)).toBe(mid.get(a.clientId));
  });
});

const uniform = (boxCount: number) => ({
  boxCount,
  dimsMode: 'uniform',
  boxLengthCm: 50,
  boxWidthCm: 40,
  boxHeightCm: 30,
  boxWeightKg: 10,
});
const office = (wh: string) =>
  countDoorFor({ id: actorId, permissions: new Set(['plans.manage']), warehouseScoped: false, warehouseIds: [] }, wh)!;
async function cost(scope: 'batch' | 'receipt', id: string, amount: number) {
  return addCostEntry(
    {
      scope,
      ...(scope === 'batch' ? { batchId: id } : { receiptId: id }),
      costTypeId: freightType,
      amount,
      currency: 'USD',
      costDate: '1638-02-02',
      allocationBasis: 'weight',
    } as never,
    ctx(),
  );
}
async function loadAll(truckId: string) {
  const planned = await db
    .select({ code: boxes.shortCode })
    .from(boxes)
    .where(and(eq(boxes.currentBatchId, truckId), eq(boxes.status, 'planned')));
  const acks = await ingestLoadScans(planned.map((p) => qr(truckId, p.code)), ctx());
  expect(acks.every((x) => x.result === 'ok')).toBe(true);
}
async function lotRow(lotId: string) {
  const [row] = await db.select().from(receiptLots).where(eq(receiptLots.id, lotId));
  return { boxes: row!.boxCount, kg: Number(row!.totalWeightKg) };
}

describe('a growth the office takes back is undone, prixod and money (review money-1, money-3)', () => {
  it('at LOAD: a dial past the stock and back lands on the lot it started from', async () => {
    const a = await mkLot(uniform(3));
    const receiptCost = await cost('receipt', a.receiptId, 30);
    const t = await planTruck([{ lotId: a.lotId, take: 3 }]);
    const up = await countLoadLot(
      { batchId: t.id, lotId: a.lotId, target: 5, seenAboard: 0, pressId: uuidv4(), overReason: 'ikki ortiq' },
      ctx(),
      office(W.cn),
    );
    expect(up.grown).toBe(2);
    expect(await lotRow(a.lotId)).toEqual({ boxes: 5, kg: 50 });
    // The office typed 5 by mistake — the truck carries 3.
    const down = await countLoadLot(
      { batchId: t.id, lotId: a.lotId, target: 3, seenAboard: 5, pressId: uuidv4(), overReason: '' },
      ctx(),
      office(W.cn),
    );
    expect([down.aboard, down.shrunk]).toEqual([3, 2]);
    expect(await lotRow(a.lotId)).toEqual({ boxes: 3, kg: 30 });
    const statuses = await db.select({ s: boxes.status }).from(boxes).where(eq(boxes.lotId, a.lotId));
    expect(statuses.filter((r) => r.s === 'void')).toHaveLength(2);
    // The prixod's own cost is back over the three cartons that exist.
    const shares = await db
      .select({ n: sql<number>`count(*)`, usd: sql<string>`sum(${costAllocations.amountUsd})` })
      .from(costAllocations)
      .innerJoin(boxes, eq(boxes.id, costAllocations.boxId))
      .where(and(eq(costAllocations.costEntryId, receiptCost.id), sql`${boxes.status} <> 'void'`));
    expect([Number(shares[0]!.n), Math.round(Number(shares[0]!.usd))]).toEqual([3, 30]);
  });

  it('at UNLOAD: «50» typed for 5 is taken back by the next press, and the truck’s freight with it', async () => {
    const a = await mkLot(uniform(5));
    const b = await mkLot(uniform(5));
    const t = await planTruck([
      { lotId: a.lotId, take: 5 },
      { lotId: b.lotId, take: 5 },
    ]);
    await loadAll(t.id);
    await finishLoading(t.id, ctx());
    await departBatch(t.id, ctx());
    await recomputeAll({ batchId: t.id });
    const fr = await cost('batch', t.id, 100);
    expect((await sharesByClient(fr.id)).get(b.clientId)).toBe(50);
    const typo = await countAcceptLot(
      { batchId: t.id, lotId: a.lotId, target: 50, seenArrived: 0, pressId: uuidv4(), overReason: 'ortiq keldi', confirmArrival: true },
      ctx(),
      { dest: office(W.uz), origin: office(W.cn) },
    );
    expect(typo.grown).toBe(45);
    expect(await lotRow(a.lotId)).toEqual({ boxes: 50, kg: 500 });
    await ingestUnloadScans(b.boxes.map((x) => qr(t.id, x.code)), ctx());
    // Below what arrived, with a reason: the 45 the count minted go back out.
    const back = await countAcceptLot(
      { batchId: t.id, lotId: a.lotId, target: 5, seenArrived: 50, pressId: uuidv4(), overReason: 'xato yozilgan', confirmArrival: false },
      ctx(),
      { dest: office(W.uz), origin: office(W.cn) },
    );
    expect([back.arrived, back.undone]).toEqual([5, 45]);
    expect(await lotRow(a.lotId)).toEqual({ boxes: 5, kg: 50 });
    await recomputeAll({ batchId: t.id });
    const shares = await sharesByClient(fr.id);
    expect([shares.get(a.clientId), shares.get(b.clientId)]).toEqual([50, 50]);
  });

  it('at UNLOAD, mixed: the growth comes off first, the origin’s cartons go home and stop riding', async () => {
    const a = await mkLot(uniform(8));
    const t = await planTruck([{ lotId: a.lotId, take: 5 }]);
    await loadAll(t.id);
    await finishLoading(t.id, ctx());
    await departBatch(t.id, ctx());
    // 10 typed: 5 aboard, the 3 left at the origin, 2 minted.
    const over = await countAcceptLot(
      { batchId: t.id, lotId: a.lotId, target: 10, seenArrived: 0, pressId: uuidv4(), overReason: 'ortiq keldi', confirmArrival: true },
      ctx(),
      { dest: office(W.uz), origin: office(W.cn) },
    );
    expect([over.landed, over.over, over.grown]).toEqual([10, 5, 2]);
    const back = await countAcceptLot(
      { batchId: t.id, lotId: a.lotId, target: 5, seenArrived: 10, pressId: uuidv4(), overReason: 'xato yozilgan', confirmArrival: false },
      ctx(),
      { dest: office(W.uz), origin: office(W.cn) },
    );
    expect([back.arrived, back.undone]).toEqual([5, 5]);
    expect(await lotRow(a.lotId)).toEqual({ boxes: 8, kg: 80 });
    const all = await db
      .select({ s: boxes.status, wh: boxes.currentWarehouseId })
      .from(boxes)
      .where(eq(boxes.lotId, a.lotId));
    expect(all.filter((r) => r.s === 'void')).toHaveLength(2);
    expect(all.filter((r) => r.s === 'in_stock' && r.wh === W.cn)).toHaveLength(3);
    const riders = (await db.execute(sql`${riderRowsSql({ batches: sql`${t.id}::uuid` })}`)) as unknown as unknown[];
    expect(riders).toHaveLength(5);
    // Nothing a truck carried is ever un-landed: below 5 is still refused,
    // and the refusal names the lowest number the press could reach.
    await expect(
      countAcceptLot(
        { batchId: t.id, lotId: a.lotId, target: 4, seenArrived: 5, pressId: uuidv4(), overReason: 'yana kam', confirmArrival: false },
        ctx(),
        { dest: office(W.uz), origin: office(W.cn) },
      ),
    ).rejects.toMatchObject({ code: 'count_below_arrived', detail: { arrived: 5, min: 5 } });
  });
});
