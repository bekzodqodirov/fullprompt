import 'dotenv/config';
import ExcelJS from 'exceljs';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  accountTransfers,
  attachments,
  boxMovements,
  boxes,
  clients,
  costAllocations,
  costEntries,
  costTypes,
  dealStages,
  deals,
  events,
  expenseCategories,
  expenses,
  clientTransactions,
  leadStages,
  leads,
  moneyAccounts,
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
import { decidedLeadCounts, salesAnalytics } from '@/modules/wms/crm/analytics';
import { openDealsSummary } from '@/modules/wms/deals/service';
import {
  accountBalances,
  addExpense,
  addTransfer,
  expenseTotals,
  listExpenses,
} from '@/modules/wms/accounting/service';
import { addPartnerTx } from '@/modules/wms/partners/service';
import { companyBalance, pnlGaps, profitAndLoss } from '@/modules/wms/accounting/reports';
import { addTransaction, placePayment } from '@/modules/wms/finance/service';
import { latestTxDate } from '@/modules/wms/finance/dates';
import { moneyFlowCounts } from '@/modules/wms/home/role-flows';
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
const madeLeads: string[] = [];
const madeDeals: string[] = [];
const madeAccounts: string[] = [];
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
  await db.delete(clientTransactions).where(eq(clientTransactions.clientId, clientId));
  if (madeAccounts.length) {
    await db.delete(accountTransfers).where(inArray(accountTransfers.fromAccountId, madeAccounts));
    await db.delete(partnerTransactions).where(inArray(partnerTransactions.accountId, madeAccounts));
    await db.delete(moneyAccounts).where(inArray(moneyAccounts.id, madeAccounts));
  }
  if (madeLeads.length) await db.delete(leads).where(inArray(leads.id, madeLeads));
  if (madeDeals.length) await db.delete(deals).where(inArray(deals.id, madeDeals));
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

describe('won money is dollars, net of the discount (A19, A21)', () => {
  // A month nothing else writes decisions into.
  const from = new Date('2031-01-01T00:00:00Z');
  const to = new Date('2031-02-01T00:00:00Z');
  const closedAt = new Date('2031-01-10T09:00:00Z');

  it('a so\'m quote is counted beside the dollars, never added to them', async () => {
    const [won] = await db.select().from(leadStages).where(eq(leadStages.kind, 'won')).limit(1);
    const before = await decidedLeadCounts(from, to);
    const made = await db
      .insert(leads)
      .values([
        { name: `A19 usd ${STAMP}`, stageId: won!.id, createdBy: actorId, quotedAmount: '1200', quotedCurrency: 'USD', closedAt },
        { name: `A19 uzs ${STAMP}`, stageId: won!.id, createdBy: actorId, quotedAmount: '12000000', quotedCurrency: 'UZS', closedAt },
      ])
      .returning({ id: leads.id });
    madeLeads.push(...made.map((row) => row.id));

    const after = await decidedLeadCounts(from, to);
    expect(after.won - before.won).toBe(2);
    // Before the fix: 12,001,200 «dollars».
    expect(Math.round((after.wonUsd - before.wonUsd) * 100) / 100).toBe(1200);
    expect(after.wonOtherCurrency - before.wonOtherCurrency).toBe(1);

    const scoreboard = await salesAnalytics({ from, to });
    expect(scoreboard.totals.wonUsd).toBe(after.wonUsd);
  });

  it("a deal's won and open money is what the card prints — the discount taken off", async () => {
    const [won] = await db.select().from(dealStages).where(eq(dealStages.kind, 'won')).limit(1);
    const [open] = await db.select().from(dealStages).where(eq(dealStages.kind, 'open')).limit(1);
    const blockBefore = (await salesAnalytics({ from, to })).deals!;
    const openBefore = await openDealsSummary();
    const made = await db
      .insert(deals)
      .values([
        {
          code: `A21-${STAMP}-1`, clientId, stageId: won!.id, title: 'A21 won', createdBy: actorId,
          quotedAmount: '1000', quotedCurrency: 'USD', discountAmount: '150', discountReason: 'shikast', closedAt,
        },
        {
          code: `A21-${STAMP}-2`, clientId, stageId: won!.id, title: 'A21 won uzs', createdBy: actorId,
          quotedAmount: '9000000', quotedCurrency: 'UZS', closedAt,
        },
        {
          code: `A21-${STAMP}-3`, clientId, stageId: open!.id, title: 'A21 open', createdBy: actorId,
          quotedAmount: '500', quotedCurrency: 'USD', discountAmount: '50', discountReason: 'shikast',
        },
      ])
      .returning({ id: deals.id });
    madeDeals.push(...made.map((row) => row.id));

    const block = (await salesAnalytics({ from, to })).deals!;
    expect(Math.round((block.wonUsd - blockBefore.wonUsd) * 100) / 100).toBe(850);
    expect(block.wonOtherCurrency - blockBefore.wonOtherCurrency).toBe(1);
    const openAfter = await openDealsSummary();
    expect(Math.round((openAfter.usdSum - openBefore.usdSum) * 100) / 100).toBe(450);
  });
});

describe('a payment lands in a till, on a real day (A2, A23)', () => {
  const today = new Date().toISOString().slice(0, 10);

  it('a charge dated years ahead is refused; tomorrow (Tashkent after midnight) is not', async () => {
    const row = { clientId, type: 'charge' as const, amount: 10, currency: 'USD' };
    await expect(addTransaction({ ...row, txDate: '2308-04-01' }, ctx())).rejects.toMatchObject({
      code: 'future_date',
    });
    await addTransaction({ ...row, txDate: latestTxDate() }, ctx());
  });

  it('an unplaced payment is on the Balans until it is placed, and the net never moves', async () => {
    const [account] = await db
      .insert(moneyAccounts)
      .values({ name: `Audit kassa ${STAMP}`, currency: 'USD' })
      .returning();
    madeAccounts.push(account!.id);
    const [uzs] = await db
      .insert(moneyAccounts)
      .values({ name: `Audit so'm ${STAMP}`, currency: 'UZS' })
      .returning();
    madeAccounts.push(uzs!.id);

    await addTransaction({ clientId, type: 'charge', amount: 500, currency: 'USD', txDate: today }, ctx());
    const before = await companyBalance();
    const counterBefore = (await moneyFlowCounts(today)).unassignedPayments;

    // Saved with no kassa — every payment before this round could be.
    const payment = await addTransaction(
      { clientId, type: 'payment', amount: 500, currency: 'USD', txDate: today },
      ctx(),
    );
    const unplaced = await companyBalance();
    expect(Math.round((unplaced.receivableUsd - before.receivableUsd) * 100) / 100).toBe(-500);
    expect(Math.round((unplaced.unplacedUsd - before.unplacedUsd) * 100) / 100).toBe(500);
    // Before the fix the net fell by $500 here: money received, in no line.
    expect(unplaced.netUsd).toBe(before.netUsd);
    expect((await moneyFlowCounts(today)).unassignedPayments).toBe(counterBefore + 1);

    // Only into a box speaking its currency…
    await expect(placePayment(payment.id, uzs!.id, ctx())).rejects.toMatchObject({
      code: 'account_currency_mismatch',
    });
    await placePayment(payment.id, account!.id, ctx());
    const placed = await companyBalance();
    expect(Math.round((placed.unplacedUsd - before.unplacedUsd) * 100) / 100).toBe(0);
    expect(Math.round((placed.cashUsd - before.cashUsd) * 100) / 100).toBe(500);
    expect(placed.netUsd).toBe(before.netUsd);
    expect((await moneyFlowCounts(today)).unassignedPayments).toBe(counterBefore);
    // …and once.
    await expect(placePayment(payment.id, account!.id, ctx())).rejects.toMatchObject({
      code: 'already_placed',
    });
  });
});

describe('a till adds up and keeps its money (A34, A35)', () => {
  const today = new Date().toISOString().slice(0, 10);
  const till = async (name: string) => {
    const [row] = await db.insert(moneyAccounts).values({ name: `${name} ${STAMP}`, currency: 'USD' }).returning();
    madeAccounts.push(row!.id);
    return row!.id;
  };

  it('between two tills of one currency, the money out is the money in', async () => {
    const a = await till('A35 a');
    const b = await till('A35 b');
    const row = { fromAccountId: a, toAccountId: b, transferDate: today, note: '' };
    // Before the fix $900 left the kassa totals and no report ever saw it.
    await expect(addTransfer({ ...row, amountFrom: 1000, amountTo: 100 }, ctx())).rejects.toMatchObject({
      code: 'amount_mismatch',
    });
    await addTransfer({ ...row, amountFrom: 100, amountTo: 100 }, ctx());
  });

  it("a row's opening + in − out is its balance, a firm's money included", async () => {
    const id = await till('A34');
    await addPartnerTx(
      { partnerId, type: 'receipt', amount: 700, currency: 'USD', txDate: today, accountId: id, batchId: '', note: '' },
      ctx(),
    );
    await addPartnerTx(
      { partnerId, type: 'payment', amount: 200, currency: 'USD', txDate: today, accountId: id, batchId: '', note: '' },
      ctx(),
    );
    const row = (await accountBalances()).find((r) => r.id === id)!;
    const shownIn = row.paidIn + row.transferredIn + row.partnerIn;
    const shownOut = row.spent + row.transferredOut + row.partnerOut;
    expect(shownIn).toBe(700);
    expect(shownOut).toBe(200);
    expect(row.opening + shownIn - shownOut).toBe(row.balance);
  });
});
