import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  costEntries,
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
  setCostAccount,
  setCostStaffPayer,
  unplacedCostTotals,
  upsertFxRate,
} from '@/modules/wms/costing/service';
import { accountBalances, addExpense } from '@/modules/wms/accounting/service';
import { cashFlow } from '@/modules/wms/accounting/reports';
import { mergeDuplicate } from '@/modules/wms/accounting/cost-merge';
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

afterAll(async () => {
  await db.delete(partnerTransactions).where(inArray(partnerTransactions.partnerId, [staffPartnerId, firmId]));
  if (madeCosts.length) await db.delete(costEntries).where(inArray(costEntries.id, madeCosts));
  if (madeExpenses.length) await db.delete(expenses).where(inArray(expenses.id, madeExpenses));
  await db.delete(partners).where(inArray(partners.id, [staffPartnerId, firmId]));
  await db.delete(moneyAccounts).where(inArray(moneyAccounts.id, [usdTill, qkaTill]));
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

  it('a merged cost left the queue — even when the expense named no kassa — and cannot be merged twice', async () => {
    const before = await unplacedCostTotals();
    const id = await cost(15, 'USD');
    // An expense typed before kassas were asked for: the merge removes the
    // double and the cost stays kassa-less, but it is ANSWERED — off the queue.
    const first = await expense(15, 'USD', '');
    const second = await expense(15, 'USD', usdTill);
    await mergeDuplicate({ costIds: [id], expenseId: first }, ctx());
    expect((await unplacedCostTotals()).count).toBe(before.count);
    await expect(mergeDuplicate({ costIds: [id], expenseId: second }, ctx())).rejects.toMatchObject({
      code: 'cost_taken',
    });
  });
});
