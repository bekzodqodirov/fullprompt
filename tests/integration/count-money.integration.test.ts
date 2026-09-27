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
