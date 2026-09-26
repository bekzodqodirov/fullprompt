import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  batches,
  costEntries,
  expenseRequests,
  costTypes,
  currencies,
  expenseCategories,
  expenses,
  moneyAccounts,
  partnerTransactions,
  partnerTypes,
  partners,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import {
  addCostEntry,
  placeCostAccount,
  setCostAccount,
  setCostStaffPayer,
  unplacedCostTotals,
  upsertFxRate,
  voidCostEntry,
} from '@/modules/wms/costing/service';
import { accountBalances, addExpense, voidExpense } from '@/modules/wms/accounting/service';
import { cashFlow, cashFlowByMonth, companyBalance } from '@/modules/wms/accounting/reports';
import { mergeCandidates, mergeDuplicate, RESTORED_DAYS, sameMoney, unmergeDuplicate } from '@/modules/wms/accounting/cost-merge';
import { partnerBalanceUsd } from '@/modules/wms/partners/service';

/**
 * The owner's 3b (0101): a cargo cost names the kassa its money left from,
 * or waits for the accountant to say; and the same money typed a second time
 * as an expense is merged away by the M4a rule — the drawer unmoved, the
 * double gone.
 *
 * A test currency of its own (QKA, 1000 per dollar) so the cross-currency
 * cases never depend on another file's rates; cost dates in 1650 so no
 * period another file reads is touched.
 */

const STAMP = String(Date.now()).slice(-6);
const CCY = 'QKA';
const DAY = '1650-06-10';
let actorId = '';
let costTypeId = '';
let categoryId = '';
let batchId = '';
let usdTill = '';
let qkaTill = '';
let staffPartnerId = '';
let firmId = '';
const madeWarehouses: string[] = [];
const madeCosts: string[] = [];
const madeExpenses: string[] = [];
/** Tills with an opening count, for the merge-across-the-count cases (U07). */
const countedTills: string[] = [];
const ctx = () => ({ actorId });

async function cost(amount: number, currency: string, over: Record<string, unknown> = {}) {
  const entry = await addCostEntry(
    {
      scope: 'batch',
      batchId,
      costTypeId,
      amount,
      currency,
      costDate: DAY,
      allocationBasis: 'weight',
      ...over,
    },
    ctx(),
  );
  madeCosts.push(entry.id);
  return entry.id;
}

async function expense(amount: number, currency: string, accountId: string, over: Record<string, unknown> = {}) {
  const row = await addExpense(
    { categoryId, amount, currency, expenseDate: DAY, accountId, ...over },
    ctx(),
  );
  madeExpenses.push(row.id);
  return row.id;
}

const tillBalance = async (id: string) => (await accountBalances()).find((row) => row.id === id)!.balance;

/**
 * An expense typed BEFORE kassas were asked for (`cost_kassa_since`): its
 * entry clock moved back, the stand-in for pre-0101 production history (the
 * same move the history COST gets below).
 */
const typedBeforeKassas = (expenseId: string) =>
  db.update(expenses).set({ createdAt: new Date('2000-01-01T00:00:00Z') }).where(eq(expenses.id, expenseId));
const cents = (value: number) => Math.round(value * 100) / 100;

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  costTypeId = (await db.select({ id: costTypes.id }).from(costTypes).limit(1))[0]!.id;
  categoryId = (
    await db.insert(expenseCategories).values({ name: `Kassa test ${STAMP}` }).returning()
  )[0]!.id;
  await db.insert(currencies).values({ code: CCY, name: 'Kassa test' }).onConflictDoNothing();
  await upsertFxRate({ currency: CCY, rateToUsd: 0.001, effectiveDate: '1601-01-01' }, ctx());
  for (const [code, country] of [
    [`KQ${STAMP}`, 'CN'],
    [`KR${STAMP}`, 'UZ'],
  ] as const) {
    const [row] = await db
      .insert(warehouses)
      .values({ code, batchPrefix: code, name: code, country, type: 'origin', timezone: 'Asia/Shanghai' })
      .returning();
    madeWarehouses.push(row!.id);
  }
  batchId = uuidv4();
  await db.insert(batches).values({
    id: batchId,
    code: `KQ${STAMP}-001`,
    originWarehouseId: madeWarehouses[0]!,
    destWarehouseId: madeWarehouses[1]!,
    status: 'forming',
    createdBy: actorId,
  });
  usdTill = (
    await db.insert(moneyAccounts).values({ name: `Kassa USD ${STAMP}`, currency: 'USD' }).returning()
  )[0]!.id;
  qkaTill = (
    await db.insert(moneyAccounts).values({ name: `Kassa QKA ${STAMP}`, currency: CCY }).returning()
  )[0]!.id;
  const [staffType] = await db.select().from(partnerTypes).where(eq(partnerTypes.code, 'staff'));
  const [otherType] = await db.select().from(partnerTypes).where(eq(partnerTypes.code, 'transport'));
  staffPartnerId = (
    await db
      .insert(partners)
      .values({ name: `Hodim ${STAMP}`, typeId: staffType!.id, createdBy: actorId })
      .returning()
  )[0]!.id;
  firmId = (
    await db
      .insert(partners)
      .values({ name: `Firma ${STAMP}`, typeId: otherType!.id, createdBy: actorId })
      .returning()
  )[0]!.id;
});

/** Rasxod xabari rows the Q8 claim test ties to an expense (FK first). */
const madeRequests: string[] = [];

afterAll(async () => {
  if (madeRequests.length) await db.delete(expenseRequests).where(inArray(expenseRequests.id, madeRequests));
  await db.delete(partnerTransactions).where(inArray(partnerTransactions.partnerId, [staffPartnerId, firmId]));
  if (madeCosts.length) await db.delete(costEntries).where(inArray(costEntries.id, madeCosts));
  if (madeExpenses.length) await db.delete(expenses).where(inArray(expenses.id, madeExpenses));
  await db.delete(partners).where(inArray(partners.id, [staffPartnerId, firmId]));
  await db.delete(moneyAccounts).where(inArray(moneyAccounts.id, [usdTill, qkaTill, ...countedTills]));
  await db.delete(batches).where(eq(batches.id, batchId));
  await db.delete(warehouses).where(inArray(warehouses.id, madeWarehouses));
  await db.delete(expenseCategories).where(eq(expenseCategories.id, categoryId));
  await pgClient.end();
});

describe('a cost names the kassa its money left from (3b)', () => {
  it('the kassa pays it — in its own currency — and the cash flow says which part a kassa answered', async () => {
    const before = await tillBalance(usdTill);
    await cost(120, 'USD', { accountId: usdTill });
    expect(await tillBalance(usdTill)).toBe(before - 120);
    const flow = await cashFlow(DAY, DAY);
    expect(flow.cargoFromTillUsd).toBeGreaterThanOrEqual(120);
  });

  it('a kassa in another currency needs what left it, typed — the bank knew the rate, we did not', async () => {
    await expect(cost(50, 'USD', { accountId: qkaTill })).rejects.toMatchObject({
      code: 'account_amount_required',
    });
    const before = await tillBalance(qkaTill);
    await cost(50, 'USD', { accountId: qkaTill, accountAmount: 50_500 });
    expect(await tillBalance(qkaTill)).toBe(before - 50_500);
  });

  it('a payer is ONE of a counterparty or a kassa', async () => {
    await expect(cost(10, 'USD', { accountId: usdTill, partnerId: firmId })).rejects.toMatchObject({
      code: 'payer_conflict',
    });
  });
});

describe("the accountant's queue", () => {
  it('a cost typed with no kassa waits, and leaves the queue once placed', async () => {
    const before = await unplacedCostTotals();
    const id = await cost(30, 'USD');
    expect((await unplacedCostTotals()).count).toBe(before.count + 1);
    const tillBefore = await tillBalance(usdTill);
    await setCostAccount(id, usdTill, undefined, ctx());
    expect((await unplacedCostTotals()).count).toBe(before.count);
    expect(await tillBalance(usdTill)).toBe(tillBefore - 30);
    // Moved to another kassa by the accountant: the first gets it back.
    await setCostAccount(id, qkaTill, 30_000, ctx());
    expect(await tillBalance(usdTill)).toBe(tillBefore);
  });

  it('a non-holder’s void re-judges the PAYER it saw: a colleague’s «o’z pulimdan» written after the look refuses it (review, C19)', async () => {
    const id = await cost(35, 'USD');
    // The door looked: no kassa, no payer. The accountant then answers the
    // queue with a colleague's own pocket before the void's claim runs.
    await setCostStaffPayer(id, staffPartnerId, ctx());
    await expect(voidCostEntry(id, 'xato', ctx(), { mayMoveTill: false, payerSeen: null })).rejects.toMatchObject({
      code: 'cost_payer_changed',
    });
    const [row] = await db.select({ voidedAt: costEntries.voidedAt }).from(costEntries).where(eq(costEntries.id, id));
    expect(row!.voidedAt).toBeNull();
    // What the door judged is what stands: the same void goes through.
    const plain = await cost(36, 'USD');
    await voidCostEntry(plain, 'xato', ctx(), { mayMoveTill: false, payerSeen: null });
  });

  it('a counterparty-settled cost is never put into a kassa as well', async () => {
    const id = await cost(40, 'USD', { partnerId: firmId });
    await expect(setCostAccount(id, usdTill, undefined, ctx())).rejects.toMatchObject({
      code: 'payer_conflict',
    });
  });

  it("«a colleague paid it» books the debt to their staff account, and only a staff account", async () => {
    const id = await cost(25, 'USD');
    await expect(setCostStaffPayer(id, firmId, ctx())).rejects.toMatchObject({ code: 'not_staff' });
    const before = await partnerBalanceUsd(staffPartnerId);
    await setCostStaffPayer(id, staffPartnerId, ctx());
    expect(await partnerBalanceUsd(staffPartnerId)).toBe(before + 25);
    const [row] = await db.select().from(costEntries).where(eq(costEntries.id, id));
    expect(row!.partnerId).toBe(staffPartnerId);
  });
});

describe('the duplicate merge (A3, M4a)', () => {
  it('1:1, same currency: the expense goes, its kassa moves onto the cost, the drawer does not move', async () => {
    const costId = await cost(200, 'USD');
    const expenseId = await expense(200, 'USD', usdTill);
    const drawer = await tillBalance(usdTill);
    await mergeDuplicate({ costIds: [costId], expenseId }, ctx());
    expect(await tillBalance(usdTill)).toBe(drawer);
    const [e] = await db.select().from(expenses).where(eq(expenses.id, expenseId));
    expect(e!.voidedAt).not.toBeNull();
    const [c] = await db.select().from(costEntries).where(eq(costEntries.id, costId));
    expect(c).toMatchObject({ accountId: usdTill, accountAmount: '200.00', mergedExpenseId: expenseId });
  });

  it('N:1 across currencies within 2 % or $5: the shares add up to the expense to the cent', async () => {
    const a = await cost(60, 'USD');
    const b = await cost(40, 'USD');
    // $101.50 of QKA against $100 of cost: 1.5 % — the same money.
    const expenseId = await expense(101_500, CCY, qkaTill);
    const drawer = await tillBalance(qkaTill);
    await mergeDuplicate({ costIds: [a, b], expenseId }, ctx());
    expect(await tillBalance(qkaTill)).toBe(drawer);
    const rows = await db.select().from(costEntries).where(inArray(costEntries.id, [a, b]));
    const total = rows.reduce((sum, row) => sum + Number(row.accountAmount), 0);
    expect(Math.round(total * 100) / 100).toBe(101_500);
  });

  it('refuses money that is not the same: a cent off, a month apart, a partner-paid expense', async () => {
    const off = await cost(70, 'USD');
    const offExpense = await expense(70.01, 'USD', usdTill);
    await expect(mergeDuplicate({ costIds: [off], expenseId: offExpense }, ctx())).rejects.toMatchObject({
      code: 'amount_differs',
    });
    const far = await cost(80, 'USD', { costDate: '1650-08-01' });
    const farExpense = await expense(80, 'USD', usdTill);
    await expect(mergeDuplicate({ costIds: [far], expenseId: farExpense }, ctx())).rejects.toMatchObject({
      code: 'too_far_apart',
    });
    const debt = await cost(90, 'USD');
    const debtExpense = await expense(90, 'USD', '', { partnerId: firmId });
    await expect(mergeDuplicate({ costIds: [debt], expenseId: debtExpense }, ctx())).rejects.toMatchObject({
      code: 'not_candidate',
    });
  });

  it('a BOOK entry (a non-cash kind — depreciation) is never offered or absorbed as a duplicate (review of the merge)', async () => {
    const [book] = await db
      .insert(expenseCategories)
      .values({ name: `Amortizatsiya ${STAMP}`, cash: false })
      .returning();
    try {
      const target = await cost(95, 'USD');
      const depreciation = await expense(95, 'USD', '', { categoryId: book!.id });
      expect((await mergeCandidates(DAY, DAY)).map((row) => row.id)).not.toContain(depreciation);
      await expect(mergeDuplicate({ costIds: [target], expenseId: depreciation }, ctx())).rejects.toMatchObject({
        code: 'not_candidate',
      });
      const [still] = await db.select({ voidedAt: expenses.voidedAt }).from(expenses).where(eq(expenses.id, depreciation));
      expect(still!.voidedAt).toBeNull();
    } finally {
      await db.delete(expenses).where(eq(expenses.categoryId, book!.id));
      await db.delete(expenseCategories).where(eq(expenseCategories.id, book!.id));
    }
  });

  it('merged with a kassa-less expense typed BEFORE kassas were asked for: history, off the queue — and never merged twice', async () => {
    const before = await unplacedCostTotals();
    const id = await cost(15, 'USD');
    // The expense is history inside a counted opening (#1018): the merge
    // removes the double and the cost is answered with it — placing it now
    // would debit a drawer that already counted the money.
    const first = await expense(15, 'USD', '');
    await typedBeforeKassas(first);
    const second = await expense(15, 'USD', usdTill);
    await mergeDuplicate({ costIds: [id], expenseId: first }, ctx());
    expect((await unplacedCostTotals()).count).toBe(before.count);
    await expect(mergeDuplicate({ costIds: [id], expenseId: second }, ctx())).rejects.toMatchObject({
      code: 'cost_taken',
    });
  });

  it('merged with a kassa-less expense typed SINCE: still unplaced money — on the queue, the net unmoved, a colleague can still be named (U02)', async () => {
    const id = await cost(17, 'USD');
    const typed = await companyBalance();
    const queued = await unplacedCostTotals();
    // The same money typed again as an expense naming no kassa (a non-cash
    // kind, a direct service caller, or a firm-paid one whose charge was
    // voided): it moved no drawer, so the Balans does not move either.
    const twin = await expense(17, 'USD', '');
    expect(cents((await companyBalance()).netUsd - typed.netUsd)).toBe(0);

    await mergeDuplicate({ costIds: [id], expenseId: twin }, ctx());
    // The double is gone, the kassa is still unsaid: the cost stays where the
    // accountant can answer it, and «Sof holat» does not jump on a press that
    // moved no money.
    const merged = await unplacedCostTotals();
    expect(merged.count).toBe(queued.count);
    expect(cents(merged.usd - queued.usd)).toBe(0);
    expect(cents((await companyBalance()).netUsd - typed.netUsd)).toBe(0);
    const [row] = await db.select().from(costEntries).where(eq(costEntries.id, id));
    expect(row).toMatchObject({ accountId: null, mergedExpenseId: twin });

    // Its answers still work on it — the colleague's pocket here.
    const owed = await partnerBalanceUsd(staffPartnerId);
    await setCostStaffPayer(id, staffPartnerId, ctx());
    expect(await partnerBalanceUsd(staffPartnerId)).toBe(owed + 17);
    expect((await unplacedCostTotals()).count).toBe(queued.count - 1);
    expect(cents((await companyBalance()).netUsd - typed.netUsd)).toBe(0);
  });
});

describe('a merge dates the drawer by the day the drawer PAID (U07)', () => {
  // The count sits BETWEEN the two days of each pair, which is exactly where
  // reading the cost's day moved the money across it (R4, #1012).
  const COUNT = '1650-09-01';
  const countedTill = async (openingBalance: number) => {
    const [row] = await db
      .insert(moneyAccounts)
      .values({
        name: `Sanoq ${STAMP} ${countedTills.length}`,
        currency: 'USD',
        openingBalance: String(openingBalance),
        openingDate: COUNT,
      })
      .returning();
    countedTills.push(row!.id);
    return row!.id;
  };

  it('an expense before the count, its cost after it: the drawer does not move', async () => {
    const till = await countedTill(5000);
    const expenseId = await expense(200, 'USD', till, { expenseDate: '1650-08-28' });
    const costId = await cost(200, 'USD', { costDate: '1650-09-05' });
    const drawer = await tillBalance(till);
    expect(drawer).toBe(5000); // the expense is inside the count
    await mergeDuplicate({ costIds: [costId], expenseId }, ctx());
    expect(await tillBalance(till)).toBe(drawer);
  });

  it('a cost before the count, its expense after it: the drawer does not move', async () => {
    const till = await countedTill(10000);
    const costId = await cost(250, 'USD', { costDate: '1650-08-29' });
    const expenseId = await expense(250, 'USD', till, { expenseDate: '1650-09-03' });
    const drawer = await tillBalance(till);
    expect(drawer).toBe(9750);
    await mergeDuplicate({ costIds: [costId], expenseId }, ctx());
    expect(await tillBalance(till)).toBe(drawer);
  });

  it('the cash flow keeps the outflow in the month the drawer paid, and counts it once', async () => {
    const costId = await cost(300, 'USD', { costDate: '1650-10-02' });
    const expenseId = await expense(300, 'USD', usdTill, { expenseDate: '1650-09-26' });
    const months = () => cashFlowByMonth('1650-09-01', '1650-10-31');
    const before = await months();
    await mergeDuplicate({ costIds: [costId], expenseId }, ctx());
    const after = await months();
    // September: the expense left, the cost arrived on its day — one outflow.
    expect(after.get('1650-09')!.outflow).toBe(before.get('1650-09')!.outflow);
    // October: the double is gone.
    expect(after.get('1650-10')!.outflow).toBe(Math.round((before.get('1650-10')!.outflow - 300) * 100) / 100);
    expect((await cashFlow('1650-10-01', '1650-10-31')).outflow).toBe(after.get('1650-10')!.outflow);
  });
});

describe("the cash flow's kassa-less figure is the queue's own (U23)", () => {
  it('links exactly what the queue lists; history — a cost or its merged duplicate — is named apart; the parts add up', async () => {
    const before = await cashFlow(DAY, DAY);
    const queueBefore = await unplacedCostTotals();
    await cost(41, 'USD');
    const history = await cost(43, 'USD');
    // Typed before kassas were asked for (#1018): inside a till's count.
    await db.update(costEntries).set({ createdAt: new Date('2000-01-01T00:00:00Z') }).where(eq(costEntries.id, history));
    // Merged with a kassa-less duplicate typed before kassas: history too.
    const mergedOld = await cost(47, 'USD');
    const oldTwin = await expense(47, 'USD', '');
    await typedBeforeKassas(oldTwin);
    await mergeDuplicate({ costIds: [mergedOld], expenseId: oldTwin }, ctx());
    // Merged with one typed since: still the queue's (U02).
    const mergedNew = await cost(53, 'USD');
    await mergeDuplicate({ costIds: [mergedNew], expenseId: await expense(53, 'USD', '') }, ctx());
    const after = await cashFlow(DAY, DAY);
    const queueAfter = await unplacedCostTotals();

    expect(cents(after.cargoQueuedUsd - before.cargoQueuedUsd)).toBe(94);
    expect(cents(after.cargoQueuedUsd - before.cargoQueuedUsd)).toBe(cents(queueAfter.usd - queueBefore.usd));
    expect(cents(after.cargoKassaUnknownUsd - before.cargoKassaUnknownUsd)).toBe(90);
    const row = after.rows.find((entry) => entry.label === 'cargoCosts')!.amountUsd;
    expect(cents(after.cargoFromTillUsd + after.cargoQueuedUsd + after.cargoKassaUnknownUsd)).toBe(row);
  });
});

/**
 * The owner's Q8 (the lead's A, 2026-09-25): a merge made by mistake is
 * UNDONE — the expense restored, the cost back on the queue, the drawer
 * unmoved by a cent — and until then nothing voids, moves or clears the kassa
 * of a merged cost. Each red proof below was taken by a string edit.
 */
describe('the un-merge (Q8)', () => {
  const costRow = async (id: string) => (await db.select().from(costEntries).where(eq(costEntries.id, id)))[0]!;
  const expenseRow = async (id: string) => (await db.select().from(expenses).where(eq(expenses.id, id)))[0]!;

  it('M1 1:1 — the exact inverse: the expense back, the cost on the queue, the drawer the same before, during and after', async () => {
    const costId = await cost(200, 'USD');
    const expenseId = await expense(200, 'USD', usdTill);
    const drawer = await tillBalance(usdTill);
    await mergeDuplicate({ costIds: [costId], expenseId }, ctx());
    expect(await tillBalance(usdTill)).toBe(drawer);
    const queued = await unplacedCostTotals();

    const result = await unmergeDuplicate(expenseId, ctx());
    expect(result).toMatchObject({ expenseId, costIds: [costId], costDates: [DAY], queued: 1 });
    expect(await tillBalance(usdTill)).toBe(drawer);
    expect(await expenseRow(expenseId)).toMatchObject({ voidedAt: null, voidedBy: null, voidReason: null });
    expect(await costRow(costId)).toMatchObject({
      accountId: null,
      accountAmount: null,
      accountAmountUsd: null,
      accountRateUsed: null,
      mergedExpenseId: null,
    });
    expect((await unplacedCostTotals()).count).toBe(queued.count + 1);
    const audits = await db
      .select({ entityId: auditLog.entityId, after: auditLog.after })
      .from(auditLog)
      .where(and(inArray(auditLog.entityId, [costId, expenseId]), eq(auditLog.action, 'update')));
    expect(audits.some((row) => row.entityId === expenseId && (row.after as { unmerged?: boolean }).unmerged === true)).toBe(true);
    expect(audits.some((row) => row.entityId === costId && (row.after as { unmergedFrom?: string }).unmergedFrom === expenseId)).toBe(true);
  });

  it('M2 N:1 across currencies — both costs cleared, the QKA drawer unchanged', async () => {
    const a = await cost(60, 'USD');
    const b = await cost(40, 'USD');
    const expenseId = await expense(101_500, CCY, qkaTill);
    const drawer = await tillBalance(qkaTill);
    await mergeDuplicate({ costIds: [a, b], expenseId }, ctx());
    const result = await unmergeDuplicate(expenseId, ctx());
    expect(result.costIds.sort()).toEqual([a, b].sort());
    expect(await tillBalance(qkaTill)).toBe(drawer);
    for (const id of [a, b]) {
      expect(await costRow(id)).toMatchObject({ accountId: null, accountAmount: null, accountAmountUsd: null, mergedExpenseId: null });
    }
  });

  it('M3 across an opening count, both directions — the drawer identical on every step (U07)', async () => {
    const COUNT = '1650-11-01';
    const counted = async (openingBalance: number) => {
      const [row] = await db
        .insert(moneyAccounts)
        .values({ name: `Q8 sanoq ${STAMP} ${countedTills.length}`, currency: 'USD', openingBalance: String(openingBalance), openingDate: COUNT })
        .returning();
      countedTills.push(row!.id);
      return row!.id;
    };
    for (const [expenseDate, costDate, opening] of [
      ['1650-10-28', '1650-11-05', 5000],
      ['1650-11-03', '1650-10-29', 10000],
    ] as const) {
      const till = await counted(opening);
      const expenseId = await expense(250, 'USD', till, { expenseDate });
      const costId = await cost(250, 'USD', { costDate });
      const drawer = await tillBalance(till);
      await mergeDuplicate({ costIds: [costId], expenseId }, ctx());
      expect(await tillBalance(till), `${expenseDate} merged`).toBe(drawer);
      await unmergeDuplicate(expenseId, ctx());
      expect(await tillBalance(till), `${expenseDate} un-merged`).toBe(drawer);
    }
  });

  it('M4 a merged cost cannot be voided, moved or cleared until un-merged — then it can, and the drawer holds', async () => {
    const costId = await cost(210, 'USD');
    const expenseId = await expense(210, 'USD', usdTill);
    const drawer = await tillBalance(usdTill);
    await mergeDuplicate({ costIds: [costId], expenseId }, ctx());
    await expect(voidCostEntry(costId, 'xato', ctx(), { mayMoveTill: true })).rejects.toMatchObject({ code: 'merged_cost' });
    await expect(setCostAccount(costId, qkaTill, 210_000, ctx())).rejects.toMatchObject({ code: 'merged_cost' });
    await expect(setCostAccount(costId, null, undefined, ctx())).rejects.toMatchObject({ code: 'merged_cost' });
    await expect(placeCostAccount(costId, usdTill, undefined, ctx())).rejects.toMatchObject({ code: 'already_placed' });
    expect(await costRow(costId)).toMatchObject({ accountId: usdTill, voidedAt: null, mergedExpenseId: expenseId });
    expect(await tillBalance(usdTill)).toBe(drawer);

    await unmergeDuplicate(expenseId, ctx());
    await voidCostEntry(costId, 'takror', ctx(), { mayMoveTill: true });
    expect((await costRow(costId)).voidedAt).not.toBeNull();
    expect(await tillBalance(usdTill)).toBe(drawer);
  });

  it('M4b the kassa-less merge (U02) takes its kassa on the queue, stays unvoidable — and the un-merge still undoes it', async () => {
    const costId = await cost(19, 'USD');
    const twin = await expense(19, 'USD', '');
    await mergeDuplicate({ costIds: [costId], expenseId: twin }, ctx());
    await expect(voidCostEntry(costId, 'xato', ctx(), { mayMoveTill: true })).rejects.toMatchObject({ code: 'merged_cost' });
    const drawer = await tillBalance(usdTill);
    await placeCostAccount(costId, usdTill, undefined, ctx());
    expect(await tillBalance(usdTill)).toBe(drawer - 19);
    // Placed after the merge by the queue. The first version refused the
    // un-merge here, and the void, the move and the queue all refuse a merged
    // cost — a wrong kassa had no door at all (review). The un-merge now
    // clears the queue's kassa with the link: the drawer gets its money back
    // and the cost returns to the queue to be answered again.
    const result = await unmergeDuplicate(twin, ctx());
    expect(result.costIds).toEqual([costId]);
    expect(await tillBalance(usdTill)).toBe(drawer);
    expect(await costRow(costId)).toMatchObject({ accountId: null, mergedExpenseId: null });
    expect((await expenseRow(twin)).voidedAt).toBeNull();

    // A colleague named as the payer is a live debt on their staff account:
    // cancelled there first, and the refusal says so.
    await mergeDuplicate({ costIds: [costId], expenseId: twin }, ctx());
    await setCostStaffPayer(costId, staffPartnerId, ctx());
    await expect(unmergeDuplicate(twin, ctx())).rejects.toMatchObject({ code: 'merge_staff_paid' });
    expect((await costRow(costId)).mergedExpenseId).toBe(twin);
  });

  it("M5 the queue's «Saqlash» is a claim: once, and never for a cost typed before kassas were asked for", async () => {
    const id = await cost(33, 'USD');
    const drawer = await tillBalance(usdTill);
    await placeCostAccount(id, usdTill, undefined, ctx());
    expect(await tillBalance(usdTill)).toBe(drawer - 33);
    await expect(placeCostAccount(id, qkaTill, 33_000, ctx())).rejects.toMatchObject({ code: 'already_placed' });
    expect(await tillBalance(usdTill)).toBe(drawer - 33);

    const history = await cost(34, 'USD');
    await db.update(costEntries).set({ createdAt: new Date('1650-01-01T00:00:00Z') }).where(eq(costEntries.id, history));
    await expect(placeCostAccount(history, usdTill, undefined, ctx())).rejects.toMatchObject({ code: 'already_placed' });
    await expect(setCostAccount(history, usdTill, undefined, ctx())).rejects.toMatchObject({ code: 'before_kassa_since' });
    expect((await costRow(history)).accountId).toBeNull();
  });

  it('M6 un-merge twice, a changed merge, or a person’s void is refused — and nothing is written', async () => {
    const costId = await cost(220, 'USD');
    const expenseId = await expense(220, 'USD', usdTill);
    await mergeDuplicate({ costIds: [costId], expenseId }, ctx());
    await unmergeDuplicate(expenseId, ctx());
    await expect(unmergeDuplicate(expenseId, ctx())).rejects.toMatchObject({ code: 'not_merged' });

    // A merged cost re-pointed by a hand-built write.
    const moved = await cost(230, 'USD');
    const movedExpense = await expense(230, 'USD', usdTill);
    await mergeDuplicate({ costIds: [moved], expenseId: movedExpense }, ctx());
    // Only the kassa moves — the amount still adds up, so the accountId clause
    // alone must catch it.
    await db.update(costEntries).set({ accountId: qkaTill }).where(eq(costEntries.id, moved));
    await expect(unmergeDuplicate(movedExpense, ctx())).rejects.toMatchObject({ code: 'merge_changed' });
    expect((await expenseRow(movedExpense)).voidedAt).not.toBeNull();
    expect((await costRow(moved)).mergedExpenseId).toBe(movedExpense);

    // A void that is a PERSON's, not the merge's stamp: never silently un-voided.
    const personal = await cost(240, 'USD');
    const personalExpense = await expense(240, 'USD', usdTill);
    await mergeDuplicate({ costIds: [personal], expenseId: personalExpense }, ctx());
    await db.update(expenses).set({ voidReason: 'noto‘g‘ri kiritilgan' }).where(eq(expenses.id, personalExpense));
    await expect(unmergeDuplicate(personalExpense, ctx())).rejects.toMatchObject({ code: 'merge_changed' });
    expect(await expenseRow(personalExpense)).toMatchObject({ voidReason: 'noto‘g‘ri kiritilgan' });
    expect((await costRow(personal)).accountId).toBe(usdTill);
  });

  it('M7 voidExpense is a claim: a merge landing mid-press keeps its stamp, and the rasxod xabari stays closed', async () => {
    const expenseId = await expense(250, 'USD', usdTill);
    const [request] = await db
      .insert(expenseRequests)
      .values({ amount: '250', currency: 'USD', note: `Q8 ${STAMP}`, status: 'done', createdBy: actorId, decidedBy: actorId, decidedAt: new Date(), expenseId })
      .returning({ id: expenseRequests.id });
    madeRequests.push(request!.id);
    const helper = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', { max: 1, onnotice: () => {} });
    const held = await helper.reserve();
    const stamp = 'takror → xarajat(lar): 1 ta';
    try {
      await held`BEGIN`;
      // The merge's void, committing while the person's press is in flight.
      await held`UPDATE expenses SET voided_at = now(), voided_by = ${actorId}, void_reason = ${stamp} WHERE id = ${expenseId}`;
      const voiding = voidExpense(expenseId, 'bekor', ctx());
      let waiting = false;
      for (let i = 0; i < 250 && !waiting; i += 1) {
        const rows = await db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND query ILIKE '%expenses%' AND pid <> pg_backend_pid()`);
        waiting = Number(rows[0]?.n ?? 0) > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 20));
      }
      expect(waiting, 'the void never reached the row lock').toBe(true);
      await held`COMMIT`;
      await expect(voiding).rejects.toMatchObject({ code: 'already_voided' });
    } finally {
      held.release();
      await helper.end();
    }
    expect((await expenseRow(expenseId)).voidReason).toBe(stamp);
    const [after] = await db.select().from(expenseRequests).where(eq(expenseRequests.id, request!.id));
    expect(after).toMatchObject({ status: 'done', expenseId });
  });

  it('M8 the round trip holds past the 14-day window: un-merge, void the cost, re-enter it later, merge again', async () => {
    const costId = await cost(260, 'USD');
    const expenseId = await expense(260, 'USD', usdTill);
    await mergeDuplicate({ costIds: [costId], expenseId }, ctx());
    await unmergeDuplicate(expenseId, ctx());
    await voidCostEntry(costId, 'boshqa reysga', ctx(), { mayMoveTill: true });
    const later = '1650-06-30';
    const again = await cost(260, 'USD', { costDate: later });
    // A never-merged expense of the same money on the same day: the control.
    const control = await expense(260, 'USD', usdTill);

    const candidates = await mergeCandidates(later, later);
    const restored = candidates.find((row) => row.id === expenseId);
    expect(restored?.restored).toBe(true);
    expect(candidates.some((row) => row.id === control)).toBe(false);
    const money = { amount: 260, currency: 'USD', amountUsd: 260, expenseDate: DAY };
    const theCost = { id: again, amount: 260, currency: 'USD', amountUsd: 260, costDate: later };
    expect(sameMoney([theCost], money)).toBe('too_far_apart');
    expect(sameMoney([theCost], money, { window: false })).toBeNull();

    const drawer = await tillBalance(usdTill);
    await mergeDuplicate({ costIds: [again], expenseId }, ctx());
    expect(await tillBalance(usdTill)).toBe(drawer);
    // The control is not the round trip's: the window still refuses it.
    const other = await cost(260, 'USD', { costDate: later });
    await expect(mergeDuplicate({ costIds: [other], expenseId: control }, ctx())).rejects.toMatchObject({ code: 'too_far_apart' });
  });

  it('M9 the round trip is weeks, not seasons: an un-merge older than RESTORED_DAYS keeps no exemption (review)', async () => {
    // The un-merge's OTHER ending — void the duplicate cost, keep the
    // expense — must not leave a same-sum «takror» for every cost for ever.
    const kept = await expense(270, 'USD', usdTill);
    await db.insert(auditLog).values({
      entityType: 'expense',
      entityId: kept,
      action: 'update',
      after: { unmerged: true, costIds: [] },
      createdAt: new Date(Date.now() - (RESTORED_DAYS + 1) * 86_400_000),
    });
    const later = '1650-09-30';
    const fresh = await cost(270, 'USD', { costDate: later });
    expect((await mergeCandidates(later, later)).some((row) => row.id === kept)).toBe(false);
    await expect(mergeDuplicate({ costIds: [fresh], expenseId: kept }, ctx())).rejects.toMatchObject({
      code: 'too_far_apart',
    });
  });
});
