import 'dotenv/config';
import ExcelJS from 'exceljs';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxMovements,
  boxes,
  clients,
  costAllocations,
  costEntries,
  costTypes,
  events,
  expenseCategories,
  expenses,
  partnerTransactions,
  partnerTypes,
  partners,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { landedCostByClient, landedCostByLot, unconvertedCosts } from '@/modules/wms/reports/queries';
import { addExpense, expenseTotals, listExpenses } from '@/modules/wms/accounting/service';
import { pnlGaps, profitAndLoss } from '@/modules/wms/accounting/reports';
import { buildExpensesXlsx } from '@/modules/wms/accounting/xlsx';
import { savePartner } from '@/modules/wms/partners/service';

/**
 * The reports audit of 2026-09-24, the findings that needed no decision from
 * the owner — each a number one screen printed and another contradicted.
 *
 * Every fixture lives in a month nothing else in the suite writes into, so an
 * assertion is about this file's rows and not about whatever else the shared
 * database holds; and the category this file mints is deleted at the end,
 * because an extra live category changes every expense form (#183).
 */
const STAMP = String(Date.now()).slice(-6);
let actorId = '';
let categoryId = '';
let partnerId = '';
const madeExpenses: string[] = [];
const madeReceipts: string[] = [];
const madeCosts: string[] = [];
let clientId = '';
const ctx = () => ({ actorId });

const FROM = '2018-05-01';
const TO = '2018-05-31';

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  const [category] = await db
    .insert(expenseCategories)
    .values({ name: `Audit ${STAMP}` })
    .returning();
  categoryId = category!.id;
  const [type] = await db.select().from(partnerTypes).limit(1);
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `MA${STAMP}`, name: `Money audit ${STAMP}` })
    .returning();
  clientId = client!.id;
  partnerId = await savePartner(
    null,
    { name: `Audit firma ${STAMP}`, typeId: type!.id, clientId: '', phone: '', note: '' },
    ctx(),
  );
});

afterAll(async () => {
  if (madeCosts.length) await db.delete(costEntries).where(inArray(costEntries.id, madeCosts));
  if (madeReceipts.length) {
    await db.delete(costEntries).where(inArray(costEntries.receiptId, madeReceipts));
    const lots = await db
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .where(inArray(receiptLots.receiptId, madeReceipts));
    const lotIds = lots.map((lot) => lot.id);
    if (lotIds.length) {
      const made = await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lotIds));
      if (made.length) {
        await db.delete(boxMovements).where(inArray(boxMovements.boxId, made.map((box) => box.id)));
      }
      await db.delete(boxes).where(inArray(boxes.lotId, lotIds));
      await db.delete(attachments).where(inArray(attachments.entityId, lotIds));
      await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
    }
    await db.delete(events).where(inArray(events.entityId, madeReceipts));
    await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  }
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.delete(partnerTransactions).where(eq(partnerTransactions.partnerId, partnerId));
  if (madeExpenses.length) await db.delete(expenses).where(inArray(expenses.id, madeExpenses));
  await db.delete(partners).where(eq(partners.id, partnerId));
  await db.delete(expenseCategories).where(eq(expenseCategories.id, categoryId));
  await pgClient.end();
});

async function expense(amount: number, day: string, opts: { partner?: boolean } = {}) {
  const row = await addExpense(
    {
      categoryId,
      amount,
      currency: 'USD',
      expenseDate: day,
      warehouseId: '',
      employeeId: '',
      accountId: '',
      partnerId: opts.partner ? partnerId : '',
      note: `audit ${STAMP}`,
    },
    ctx(),
  );
  madeExpenses.push(row.id);
  return row;
}

describe('the expense book tells the truth past its list (A14, A15, A17)', () => {
  it('the total is the whole period, not the rows drawn — and agrees with the P&L', async () => {
    const opexBefore = (await profitAndLoss(FROM, TO)).opexTotal.total;
    await expense(100, '2018-05-03');
    await expense(200, '2018-05-10');
    await expense(300, '2018-05-20', { partner: true });

    // The list is a slice by design; the total must not be.
    const slice = await listExpenses({ from: FROM, to: TO, categoryId, limit: 2 });
    expect(slice).toHaveLength(2);
    const totals = await expenseTotals({ from: FROM, to: TO, categoryId });
    expect(totals).toEqual({ count: 3, totalUsd: 600 });

    const opexAfter = (await profitAndLoss(FROM, TO)).opexTotal.total;
    expect(Math.round((opexAfter - opexBefore) * 100) / 100).toBe(totals.totalUsd);
  });

  it('the file names its category, its payer and the whole total', async () => {
    const file = await buildExpensesXlsx(FROM, TO, categoryId, 'uz');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(file as unknown as ArrayBuffer);
    const sheet = book.getWorksheet('Expenses')!;
    const cells = (n: number) => (sheet.getRow(n).values as unknown[]).slice(1);

    // A filtered file used to carry the whole book under a title naming only
    // the period.
    expect(String(cells(1)[0])).toContain(`Audit ${STAMP}`);

    const body: unknown[][] = [];
    sheet.eachRow((row, n) => {
      if (n > 3) body.push((row.values as unknown[]).slice(1));
    });
    const firmRow = body.find((row) => row[4] === 300);
    // «The firm paid it», not the blank cell «nobody named a till» also gets.
    expect(firmRow![5]).toBe(`→ Audit firma ${STAMP}`);
    const totalRow = body.find((row) => typeof row[4] === 'number' && row[1] === '' && row[0] !== undefined);
    expect(totalRow![4]).toBe(600);
  });
});

/** A confirmed receipt for this file's client carrying one converted cost. */
async function receiptWithCost(usd: number) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `audit/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  const [warehouse] = await db.select({ id: warehouses.id }).from(warehouses).limit(1);
  const [type] = await db.select({ id: costTypes.id }).from(costTypes).limit(1);
  await confirmReceipt(
    {
      receiptId,
      warehouseId: warehouse!.id,
      clientId,
      unclaimedMarking: '',
      lots: [
        { id: lotId, productNameZh: `货${STAMP}`, boxCount: 2, dimsMode: 'mixed', totalWeightKg: 20, totalVolumeM3: 0.2 },
      ],
      extraCosts: [{ costTypeId: type!.id, amount: usd, currency: 'USD', note: '' }],
    } as Parameters<typeof confirmReceipt>[0],
    ctx(),
  );
  madeReceipts.push(receiptId);
  const [entry] = await db.select().from(costEntries).where(eq(costEntries.receiptId, receiptId));
  return entry!;
}

describe('the landed-cost report counts only live, converted money (A24, A25)', () => {
  it("a voided entry's leftover shares are not a cost — on the index and the drill-down", async () => {
    const kept = await receiptWithCost(40);
    const ghost = await receiptWithCost(77);
    // The state a crash before #529 left, and a recompute racing a void still
    // can: the entry is voided and its shares are still on the boxes.
    await db.update(costEntries).set({ voidedAt: new Date(), voidReason: 'crash test' }).where(eq(costEntries.id, ghost.id));
    const shares = await db.select().from(costAllocations).where(eq(costAllocations.costEntryId, ghost.id));
    expect(shares.length).toBeGreaterThan(0);

    const row = (await landedCostByClient()).find((r) => r.clientId === clientId);
    expect(row!.totalUsd).toBe(40);
    const lots = await landedCostByLot(clientId);
    expect(Math.round(lots.reduce((sum, lot) => sum + lot.totalUsd, 0) * 100) / 100).toBe(40);
    expect(kept.amountUsd).toBe('40.00');
  });

  it('a cost with no dollar figure is named on the report, not dropped in silence', async () => {
    const count = async () => (await unconvertedCosts()).find((r) => r.currency === 'USD');
    const before = await count();
    const pnlBefore = await pnlGaps(FROM, TO);
    const [type] = await db.select({ id: costTypes.id }).from(costTypes).limit(1);
    // The pre-A7 state of a wizard cost: native amount, no dollars, no shares.
    const [entry] = await db
      .insert(costEntries)
      .values({
        scope: 'receipt',
        receiptId: madeReceipts[0]!,
        costTypeId: type!.id,
        amount: '13',
        currency: 'USD',
        costDate: '2018-05-05',
        allocationBasis: 'weight',
        enteredBy: actorId,
      })
      .returning();
    madeCosts.push(entry!.id);
    // And a converted one the same month, which is none of the note's business.
    const [converted] = await db
      .insert(costEntries)
      .values({
        scope: 'receipt',
        receiptId: madeReceipts[0]!,
        costTypeId: type!.id,
        amount: '5',
        currency: 'USD',
        amountUsd: '5',
        fxRateUsed: '1',
        costDate: '2018-05-06',
        allocationBasis: 'weight',
        enteredBy: actorId,
      })
      .returning();
    madeCosts.push(converted!.id);
    const after = await count();
    expect(after!.count - (before?.count ?? 0)).toBe(1);
    expect(Math.round((after!.amount - (before?.amount ?? 0)) * 100) / 100).toBe(13);
    // The P&L for its month reads it as $0 — and now says so (A11).
    const pnlAfter = await pnlGaps(FROM, TO);
    expect(pnlAfter.unconverted.count - pnlBefore.unconverted.count).toBe(1);
  });
});
