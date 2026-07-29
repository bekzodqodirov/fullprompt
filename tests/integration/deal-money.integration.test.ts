import 'dotenv/config';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  batches,
  boxes,
  clientTransactions,
  clients,
  costAllocations,
  costEntries,
  costTypes,
  deals,
  receiptLots,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import {
  createDeal,
  dealProfit,
  linkReceipt,
  setDealDiscount,
} from '@/modules/wms/deals/service';

/**
 * The deal's money (DEALS.md answers 3 and 7): a damage discount is a
 * RECORD with a reason, and profit per deal reads what was actually charged
 * against what the boxes actually cost — voided rows out on both sides, and
 * batch-priced money on the deal's trucks reported rather than guessed at.
 */

const STAMP = Date.now();
let actorId: string;
let clientId: string;
let whId: string;
let dealId: string;
let boxIds: string[] = [];
const cleanupBatches: string[] = [];
const ctx = () => ({ actorId, ip: null, userAgent: null });

const charge = (input: { amount: string; dealId?: string | null; batchId?: string | null; voided?: boolean }) =>
  db.insert(clientTransactions).values({
    clientId,
    dealId: input.dealId ?? null,
    batchId: input.batchId ?? null,
    type: 'charge',
    amount: input.amount,
    currency: 'USD',
    rateToUsd: '1',
    amountUsd: input.amount,
    txDate: new Date().toISOString().slice(0, 10),
    createdBy: actorId,
    ...(input.voided ? { voidedAt: new Date(), voidedBy: actorId, voidReason: 'test' } : {}),
  });

beforeAll(async () => {
  const [staff] = await db.select().from(users).limit(1);
  actorId = staff!.id;
  const wh = await db.query.warehouses.findFirst({ where: eq(warehouses.code, 'DMWH') });
  whId =
    wh?.id ??
    (
      await db
        .insert(warehouses)
        .values({
          code: 'DMWH',
          name: 'Deal money WH',
          country: 'CN',
          type: 'origin',
          timezone: 'Asia/Shanghai',
          batchPrefix: 'DMWH',
        })
        .returning()
    )[0]!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `DM${STAMP}`.slice(0, 12), name: `Deal money ${STAMP}` })
    .returning();
  clientId = c!.id;

  dealId = await createDeal(
    { clientId, quotedAmount: 200, quotedCurrency: 'USD', quotedVolumeM3: 0.06 },
    ctx(),
  );

  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `dmtest/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId: whId,
      clientId,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '利润货',
          boxCount: 2,
          dimsMode: 'uniform',
          boxLengthCm: 30,
          boxWidthCm: 30,
          boxHeightCm: 30,
          boxWeightKg: 5,
        },
      ],
      extraCosts: [],
    },
    ctx(),
  );
  await linkReceipt(receiptId, dealId, ctx());
  boxIds = (await db.select().from(boxes).where(eq(boxes.lotId, lotId))).map((b) => b.id);
});

afterAll(async () => {
  await db.delete(clientTransactions).where(eq(clientTransactions.clientId, clientId));
  const entries = await db
    .select()
    .from(costEntries)
    .where(eq(costEntries.note, `dm-${STAMP}`));
  const entryIds = entries.map((e) => e.id);
  if (entryIds.length > 0) {
    await db.delete(costAllocations).where(inArray(costAllocations.costEntryId, entryIds));
    await db.delete(costEntries).where(inArray(costEntries.id, entryIds));
  }
  // Undo the pretend truck ride so the batch rows can go: leftover forming
  // batches would be the batch board's input in the specs that run after
  // this file (#154).
  await db.update(boxes).set({ currentBatchId: null }).where(inArray(boxes.id, boxIds));
  if (cleanupBatches.length > 0) {
    await db.delete(batches).where(inArray(batches.id, cleanupBatches));
  }
  await db.update(warehouses).set({ active: false }).where(eq(warehouses.id, whId));
  await pgClient.end();
});

async function insertCost(totalUsd: number, boxShare: number[], voided = false) {
  const [type] = await db.select().from(costTypes).limit(1);
  const receiptId = (
    await db.select().from(receiptLots).where(eq(receiptLots.id, (await db.select().from(boxes).where(eq(boxes.id, boxIds[0]!)))[0]!.lotId))
  )[0]!.receiptId;
  const [entry] = await db
    .insert(costEntries)
    .values({
      scope: 'receipt',
      receiptId,
      costTypeId: type!.id,
      amount: String(totalUsd),
      currency: 'USD',
      amountUsd: String(totalUsd),
      fxRateUsed: '1',
      costDate: new Date().toISOString().slice(0, 10),
      allocationBasis: 'boxes',
      note: `dm-${STAMP}`,
      enteredBy: actorId,
      ...(voided ? { voidedAt: new Date(), voidedBy: actorId, voidReason: 'test' } : {}),
    })
    .returning();
  await db.insert(costAllocations).values(
    boxShare.map((amount, i) => ({
      costEntryId: entry!.id,
      boxId: boxIds[i]!,
      clientId,
      amountUsd: String(amount),
    })),
  );
}

describe('deal money', () => {
  it('a discount demands its reason, is written with an audit trail, and 0 removes it', async () => {
    await expect(setDealDiscount(dealId, { amount: 30 }, ctx())).rejects.toThrow(
      'discount_reason_required',
    );

    await setDealDiscount(dealId, { amount: 30, reason: '2 karobka shikast' }, ctx());
    let row = (await db.select().from(deals).where(eq(deals.id, dealId)))[0]!;
    expect(row.discountAmount).toBe('30.00');
    expect(row.discountReason).toBe('2 karobka shikast');
    expect(row.discountBy).toBe(actorId);
    expect(row.discountAt).not.toBeNull();

    const trail = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'deal'), eq(auditLog.entityId, dealId)));
    expect(
      trail.some((r) => (r.after as { discount?: string })?.discount === '30.00'),
    ).toBe(true);

    await setDealDiscount(dealId, { amount: 0 }, ctx());
    row = (await db.select().from(deals).where(eq(deals.id, dealId)))[0]!;
    expect(Number(row.discountAmount)).toBe(0);
    expect(row.discountReason).toBeNull();
    expect(row.discountBy).toBeNull();
  });

  it('profit = deal charges minus the boxes’ allocated cost, voided rows on neither side', async () => {
    await charge({ amount: '200', dealId });
    await insertCost(80, [40, 40]);
    // The rows that must NOT count: a voided charge and a voided cost entry.
    await charge({ amount: '999', dealId, voided: true });
    await insertCost(500, [250, 250], true);

    const profit = await dealProfit(dealId);
    expect(profit.revenueUsd).toBe(200);
    expect(profit.costUsd).toBe(80);
    expect(profit.profitUsd).toBe(120);
    expect(profit.marginPct).toBe(60);
    expect(profit.unlinkedBatchUsd).toBe(0);
  });

  it('batch-priced money on the deal’s truck is reported, not silently merged or invented', async () => {
    // A route needs two ends (batches_route_check) — any other warehouse.
    const [dest] = await db
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.active, true), ne(warehouses.id, whId)))
      .limit(1);
    const [ridden] = await db
      .insert(batches)
      .values({
        code: `DM-${STAMP}-1`,
        originWarehouseId: whId,
        destWarehouseId: dest!.id,
        createdBy: actorId,
      })
      .returning();
    const [other] = await db
      .insert(batches)
      .values({
        code: `DM-${STAMP}-2`,
        originWarehouseId: whId,
        destWarehouseId: dest!.id,
        createdBy: actorId,
      })
      .returning();
    cleanupBatches.push(ridden!.id, other!.id);

    // One deal box rides the first batch; the second batch never sees it.
    await db.update(boxes).set({ currentBatchId: ridden!.id }).where(eq(boxes.id, boxIds[0]!));
    await charge({ amount: '150', batchId: ridden!.id });
    await charge({ amount: '75', batchId: other!.id });

    const profit = await dealProfit(dealId);
    // Batch money is NOT revenue — it is the honest footnote.
    expect(profit.revenueUsd).toBe(200);
    expect(profit.unlinkedBatchUsd).toBe(150);
  });
});
