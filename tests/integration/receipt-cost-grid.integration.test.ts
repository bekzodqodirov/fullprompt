import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxMovements,
  boxes,
  clientTransactions,
  clients,
  costEntries,
  costTypes,
  events,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { createClient } from '@/modules/platform/clients/service';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import {
  addReceiptCostsBulk,
  batchClientCostBreakdown,
  batchLandedCostByClient,
  batchReceiptRows,
  boxLandedCost,
  receiptCostMatrix,
} from '@/modules/wms/costing/service';
import { addTransaction, paymentsRegister, voidTransaction } from '@/modules/wms/finance/service';
import { buildPaymentsXlsx } from '@/modules/wms/accounting/xlsx';

/**
 * Round 29: the accountant's Excel becomes the receipt-cost grid, and her
 * notebook of payments becomes the register — both driven through the REAL
 * services: one grid save is many ordinary receipt-scope cost entries,
 * allocated by the same engine as a form entry; the register reads exactly
 * what the ledger wrote.
 */

const STAMP = Date.now();
let actorId: string;
let warehouseId: string;
let clientId: string;
let receipt1: string;
let receipt2: string;
let foreignReceipt: string;
let type1: string;
let type2: string;
const fakeBatchId = uuidv4();
const ctx = () => ({ actorId });
const madeReceipts: string[] = [];
const madeTx: string[] = [];
const today = new Date().toISOString().slice(0, 10);

async function receiveCargo(): Promise<string> {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `gridtest/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  const result = await confirmReceipt(
    {
      receiptId,
      warehouseId,
      clientId,
      sourceNote: '',
      unclaimedMarking: '',
      dealId: null,
      lots: [
        {
          id: lotId,
          productNameZh: `网格 ${STAMP}`,
          productNameRu: '',
          boxCount: 1,
          dimsMode: 'mixed',
          totalWeightKg: 20,
          totalVolumeM3: 0.2,
          note: '',
        },
      ],
      extraCosts: [],
    } as Parameters<typeof confirmReceipt>[0],
    ctx(),
  );
  madeReceipts.push(result.receiptId);
  return result.receiptId;
}

async function boxOf(receiptId: string): Promise<string> {
  const [row] = await db
    .select({ id: boxes.id })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(eq(receiptLots.receiptId, receiptId));
  return row!.id;
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  warehouseId = (await db.select({ id: warehouses.id }).from(warehouses).limit(1))[0]!.id;
  clientId = (
    await createClient(
      { clientCode: `RG${String(STAMP).slice(-7)}`, name: `Jadval mijoz ${STAMP}`, phones: [] },
      ctx(),
    )
  ).id;
  receipt1 = await receiveCargo();
  receipt2 = await receiveCargo();
  foreignReceipt = await receiveCargo();
  // Two of the three rode the truck; the third stayed on the shelf — the
  // grid must offer the two and refuse the third.
  for (const receiptId of [receipt1, receipt2]) {
    await db.insert(boxMovements).values({
      boxId: await boxOf(receiptId),
      fromWarehouseId: warehouseId,
      toWarehouseId: warehouseId,
      fromStatus: 'in_stock',
      toStatus: 'in_transit',
      cause: 'batch_departed',
      refType: 'batch',
      refId: fakeBatchId,
      actorId,
    });
  }
  const types = await db
    .select({ id: costTypes.id })
    .from(costTypes)
    .where(eq(costTypes.active, true))
    .limit(2);
  type1 = types[0]!.id;
  type2 = types[1]!.id;
});

afterAll(async () => {
  // Entries first (allocations cascade), then money, then the cargo chain.
  await db.delete(costEntries).where(inArray(costEntries.receiptId, madeReceipts));
  if (madeTx.length) await db.delete(clientTransactions).where(inArray(clientTransactions.id, madeTx));
  for (const id of madeReceipts) {
    const lots = await db
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .where(eq(receiptLots.receiptId, id));
    const lotIds = lots.map((lot) => lot.id);
    if (lotIds.length) {
      const rows = await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lotIds));
      if (rows.length) {
        await db.delete(boxMovements).where(inArray(boxMovements.boxId, rows.map((b) => b.id)));
        await db.delete(boxes).where(inArray(boxes.lotId, lotIds));
      }
      await db.delete(attachments).where(inArray(attachments.entityId, lotIds));
      await db.delete(receiptLots).where(eq(receiptLots.receiptId, id));
    }
    await db.delete(events).where(eq(events.entityId, id));
    await db.delete(receipts).where(eq(receipts.id, id));
  }
  await db.delete(clients).where(eq(clients.id, clientId));
  await pgClient.end();
});

describe("the accountant's grid writes ordinary cost entries", () => {
  it('lists exactly the receipts that rode the truck', async () => {
    const rows = await batchReceiptRows(fakeBatchId);
    expect(rows.map((row) => row.receiptId).sort()).toEqual([receipt1, receipt2].sort());
    expect(rows[0]!.clientCode).toBe(`RG${String(STAMP).slice(-7)}`);
  });

  it('one save = many entries, allocated onto the right boxes', async () => {
    const saved = await addReceiptCostsBulk(
      {
        batchId: fakeBatchId,
        currency: 'USD',
        costDate: today,
        cells: [
          { receiptId: receipt1, costTypeId: type1, amount: 100 },
          { receiptId: receipt1, costTypeId: type2, amount: 50 },
          { receiptId: receipt2, costTypeId: type1, amount: 200 },
        ],
      },
      ctx(),
    );
    expect(saved).toBe(3);

    // The engine cannot tell a grid entry from a form entry: each cell is a
    // receipt-scope row, FX-frozen and allocated to the receipt's boxes.
    const box1 = await boxLandedCost(await boxOf(receipt1));
    const box2 = await boxLandedCost(await boxOf(receipt2));
    expect(box1.totalUsd).toBe(150);
    expect(box2.totalUsd).toBe(200);

    const matrix = await receiptCostMatrix([receipt1, receipt2]);
    expect(matrix.get(`${receipt1}:${type1}`)).toBe(100);
    expect(matrix.get(`${receipt1}:${type2}`)).toBe(50);
    expect(matrix.get(`${receipt2}:${type1}`)).toBe(200);

    // The «shu reysgacha» split the batch-money screen prints: everything
    // here is receipt-scope (came WITH the cargo), nothing on the truck
    // itself yet — so the whole journey is "before this trip".
    const perClient = await batchLandedCostByClient(fakeBatchId);
    const mine = perClient.get(clientId)!;
    expect(mine.totalUsd).toBe(350);
    expect(mine.batchUsd).toBe(0);

    // And the tannarx opened up (the owner's «nimalar o'tirganini ko'rsam»):
    // each part named by its source, the parts summing to the whole.
    const parts = (await batchClientCostBreakdown(fakeBatchId)).get(clientId)!;
    expect(parts.length).toBe(3);
    expect(Math.round(parts.reduce((sum, part) => sum + part.usd, 0))).toBe(350);
    expect(parts.every((part) => part.source && part.source !== '—')).toBe(true);
  });

  it("a receipt that is NOT on the batch cannot be hung with the batch's bill", async () => {
    await expect(
      addReceiptCostsBulk(
        {
          batchId: fakeBatchId,
          currency: 'USD',
          costDate: today,
          cells: [
            { receiptId: receipt1, costTypeId: type1, amount: 10 },
            { receiptId: foreignReceipt, costTypeId: type1, amount: 10 },
          ],
        },
        ctx(),
      ),
    ).rejects.toThrow('receipt_not_on_batch');
    // Refused WHOLE: the good cell must not slip through beside the bad one.
    const entries = await db
      .select()
      .from(costEntries)
      .where(
        and(
          inArray(costEntries.receiptId, [receipt1, foreignReceipt]),
          eq(costEntries.amount, '10.00'),
        ),
      );
    expect(entries.length).toBe(0);
  });
});

describe('the payments register reads what the ledger wrote', () => {
  it('shows payments of the period — and never charges or voided rows', async () => {
    const payment = await addTransaction(
      { clientId, type: 'payment', amount: 77, currency: 'USD', txDate: today },
      ctx(),
    );
    madeTx.push(payment.id);
    const charge = await addTransaction(
      { clientId, type: 'charge', amount: 500, currency: 'USD', txDate: today },
      ctx(),
    );
    madeTx.push(charge.id);
    const voided = await addTransaction(
      { clientId, type: 'payment', amount: 33, currency: 'USD', txDate: today },
      ctx(),
    );
    madeTx.push(voided.id);
    await voidTransaction(voided.id, 'xato yozildi', ctx());

    const { rows, totalUsd } = await paymentsRegister(today, today);
    const mine = rows.filter((row) => row.clientId === clientId);
    expect(mine.length).toBe(1);
    expect(Number(mine[0]!.amountUsd)).toBe(77);
    expect(totalUsd).toBeGreaterThanOrEqual(77);
  });

  it('the XLSX is a real file, not an empty sheet', async () => {
    const xlsx = await buildPaymentsXlsx(today, today, 'uz');
    expect(xlsx.length).toBeGreaterThan(1000);
  });
});
