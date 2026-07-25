import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { clients, expenses, fxRates, users } from '@/modules/platform/db/schema';
import {
  accountBalances,
  addExpense,
  addTransfer,
  generateRecurring,
  saveAccount,
  saveCategory,
  saveRecurring,
  voidExpense,
} from '@/modules/wms/accounting/service';
import {
  arAging,
  cashFlow,
  monthsBetween,
  profitAndLoss,
  profitByClient,
} from '@/modules/wms/accounting/reports';
import { addTransaction } from '@/modules/wms/finance/service';

/**
 * Phase 2.4 management accounting. This is money code — the owner will make
 * decisions from these numbers, so the arithmetic is pinned rather than
 * eyeballed.
 */

const SUFFIX = String(Date.now()).slice(-7);
let actorId: string;
let clientId: string;
let categoryId: string;
let nonCashCategoryId: string;
let accountId: string;
const ctx = () => ({ actorId });

/**
 * A period nobody else touches — and a DIFFERENT one on every run. The P&L is
 * a period query with no client filter, so a fixed month would accumulate
 * across local runs and the totals would drift upward each time.
 */
const RUN = Number(SUFFIX) % 300;
const YEAR = String(2100 + RUN);
const M1 = `${YEAR}-03`;
const M2 = `${YEAR}-04`;

beforeAll(async () => {
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `AC${SUFFIX}`, name: 'Accounting client' })
    .returning();
  clientId = client!.id;

  // Rates for the test dates; the ledger refuses a currency with no rate.
  for (const [currency, rate] of [
    ['USD', '1'],
    ['UZS', '0.00008'],
  ] as const) {
    for (const date of [`${M1}-01`, `${M1}-15`, `${M2}-01`, `${M2}-10`]) {
      await db
        .insert(fxRates)
        .values({ currency, rateToUsd: rate, effectiveDate: date, enteredBy: actorId })
        .onConflictDoNothing();
    }
  }

  const category = await saveCategory(
    { name: `Ijara test ${SUFFIX}`, cash: true, sortOrder: 10, active: true },
    ctx(),
  );
  categoryId = category.id;
  const nonCash = await saveCategory(
    { name: `Amortizatsiya test ${SUFFIX}`, cash: false, sortOrder: 20, active: true },
    ctx(),
  );
  nonCashCategoryId = nonCash.id;
  const account = await saveAccount(
    {
      name: `Kassa test ${SUFFIX}`,
      currency: 'USD',
      kind: 'cash',
      openingBalance: 1000,
      openingDate: `${M1}-01`,
      sortOrder: 10,
      active: true,
    },
    ctx(),
  );
  accountId = account.id;
});

afterAll(async () => {
  await pgClient.end();
});

describe('expenses', () => {
  it('converts to USD at the date rate and freezes it', async () => {
    const row = await addExpense(
      {
        categoryId,
        amount: 12_500_000,
        currency: 'UZS',
        expenseDate: `${M1}-15`,
        note: 'sklad ijarasi',
      },
      ctx(),
    );
    // 12 500 000 × 0.00008 = 1000.00
    expect(Number(row.amountUsd)).toBe(1000);
    expect(Number(row.rateToUsd)).toBe(0.00008);

    // Correcting the rate afterwards must not move a reported month.
    await db
      .update(fxRates)
      .set({ rateToUsd: '0.00009' })
      .where(sql`${fxRates.currency} = 'UZS' AND ${fxRates.effectiveDate} = ${`${M1}-15`}`);
    const reread = (await db.select().from(expenses).where(eq(expenses.id, row.id)))[0]!;
    expect(Number(reread.amountUsd)).toBe(1000);
    await db
      .update(fxRates)
      .set({ rateToUsd: '0.00008' })
      .where(sql`${fxRates.currency} = 'UZS' AND ${fxRates.effectiveDate} = ${`${M1}-15`}`);
  });

  it('refuses a currency with no rate instead of inventing one', async () => {
    await expect(
      addExpense(
        { categoryId, amount: 10, currency: 'AED', expenseDate: `${M1}-15` },
        ctx(),
      ),
    ).rejects.toThrow('fx_missing');
  });

  it('a voided expense leaves the P&L but keeps its row', async () => {
    const row = await addExpense(
      { categoryId, amount: 500, currency: 'USD', expenseDate: `${M1}-15` },
      ctx(),
    );
    const before = await profitAndLoss(`${M1}-01`, `${M1}-28`);
    await voidExpense(row.id, 'ikki marta kiritilgan', ctx());
    const after = await profitAndLoss(`${M1}-01`, `${M1}-28`);
    expect(before.opexTotal.total - after.opexTotal.total).toBe(500);
    expect(
      (await db.select().from(expenses).where(eq(expenses.id, row.id)))[0]!.voidReason,
    ).toBe('ikki marta kiritilgan');
    await expect(voidExpense(row.id, 'yana', ctx())).rejects.toThrow('already_voided');
  });
});

describe('P&L', () => {
  it('lists every month in the range, including empty ones', () => {
    expect(monthsBetween('2030-11-01', '2031-02-28')).toEqual([
      '2030-11',
      '2030-12',
      '2031-01',
      '2031-02',
    ]);
    expect(monthsBetween('2031-03-05', '2031-03-20')).toEqual(['2031-03']);
  });

  it('revenue − direct − overheads = net, and the margin matches', async () => {
    await addTransaction(
      {
        clientId,
        type: 'charge',
        amount: 5000,
        currency: 'USD',
        txDate: `${M2}-01`,
        note: 'kelishilgan narx',
      },
      ctx(),
    );
    await addExpense(
      { categoryId, amount: 800, currency: 'USD', expenseDate: `${M2}-10` },
      ctx(),
    );
    // Non-cash: belongs in the P&L, must stay out of the cash flow.
    await addExpense(
      { categoryId: nonCashCategoryId, amount: 200, currency: 'USD', expenseDate: `${M2}-10` },
      ctx(),
    );

    const pnl = await profitAndLoss(`${M2}-01`, `${M2}-28`);
    expect(pnl.months).toEqual([M2]);
    expect(pnl.revenue.total).toBe(5000);
    expect(pnl.opexTotal.total).toBe(1000);
    expect(pnl.grossProfit.total).toBe(pnl.revenue.total - pnl.directTotal.total);
    expect(pnl.netProfit.total).toBe(pnl.grossProfit.total - pnl.opexTotal.total);
    expect(pnl.grossMarginPct.total).toBe(
      Math.round((pnl.grossProfit.total / pnl.revenue.total) * 1000) / 10,
    );
    // Every month column adds up the same way as the total.
    const columnSum = pnl.months.reduce((acc, m) => acc + pnl.netProfit.byPeriod[m]!, 0);
    expect(Math.round(columnSum * 100) / 100).toBe(pnl.netProfit.total);
  });

  it('cash flow ignores non-cash categories', async () => {
    const flow = await cashFlow(`${M2}-01`, `${M2}-28`);
    const labels = flow.rows.map((row) => row.label);
    expect(labels).toContain(`Ijara test ${SUFFIX}`);
    expect(labels).not.toContain(`Amortizatsiya test ${SUFFIX}`);
  });
});

describe('receivables', () => {
  it('buckets a debt by the age of the charge that is still unpaid', async () => {
    const [debtor] = await db
      .insert(clients)
      .values({ clientCode: `AD${SUFFIX}`, name: 'Debtor' })
      .returning();
    const today = new Date();
    const iso = (daysAgo: number) =>
      new Date(today.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    for (const date of [iso(120), iso(45), iso(5)]) {
      await db
        .insert(fxRates)
        .values({ currency: 'USD', rateToUsd: '1', effectiveDate: date, enteredBy: actorId })
        .onConflictDoNothing();
    }

    await addTransaction(
      { clientId: debtor!.id, type: 'charge', amount: 300, currency: 'USD', txDate: iso(120) },
      ctx(),
    );
    await addTransaction(
      { clientId: debtor!.id, type: 'charge', amount: 200, currency: 'USD', txDate: iso(45) },
      ctx(),
    );
    await addTransaction(
      { clientId: debtor!.id, type: 'charge', amount: 100, currency: 'USD', txDate: iso(5) },
      ctx(),
    );
    // Paying 300 settles the OLDEST charge — the debt that remains is recent.
    await addTransaction(
      {
        clientId: debtor!.id,
        type: 'payment',
        amount: 300,
        currency: 'USD',
        method: 'cash',
        txDate: iso(5),
      },
      ctx(),
    );

    const aging = await arAging(iso(0));
    const row = aging.find((entry) => entry.clientCode === `AD${SUFFIX}`)!;
    expect(row.balance).toBe(300);
    expect(row.buckets[0]).toBe(100); // 5 days old
    expect(row.buckets[1]).toBe(200); // 45 days old
    expect(row.buckets[3]).toBe(0); // the 120-day charge was paid off
  });

  it('a client who owes nothing is not listed', async () => {
    const aging = await arAging(new Date().toISOString().slice(0, 10));
    expect(aging.every((row) => row.balance > 0)).toBe(true);
  });
});

describe('accounts', () => {
  it('balance = opening + payments in − expenses out + transfers, in its own currency', async () => {
    await addExpense(
      { categoryId, amount: 250, currency: 'USD', expenseDate: `${M2}-10`, accountId },
      ctx(),
    );
    await addTransaction(
      {
        clientId,
        type: 'payment',
        amount: 400,
        currency: 'USD',
        method: 'cash',
        txDate: `${M2}-10`,
        accountId,
      },
      ctx(),
    );

    const second = await saveAccount(
      {
        name: `Bank test ${SUFFIX}`,
        currency: 'USD',
        kind: 'bank',
        openingBalance: 0,
        sortOrder: 20,
        active: true,
      },
      ctx(),
    );
    await addTransfer(
      {
        fromAccountId: accountId,
        toAccountId: second.id,
        amountFrom: 150,
        amountTo: 150,
        transferDate: `${M2}-10`,
      },
      ctx(),
    );

    const balances = await accountBalances();
    const cash = balances.find((row) => row.id === accountId)!;
    // 1000 opening + 400 in − 250 spent − 150 transferred out
    expect(cash.balance).toBe(1000);
    expect(cash.currency).toBe('USD');
    const bank = balances.find((row) => row.id === second.id)!;
    expect(bank.balance).toBe(150);
  });

  it('refuses a transfer to the same account', async () => {
    await expect(
      addTransfer(
        {
          fromAccountId: accountId,
          toAccountId: accountId,
          amountFrom: 10,
          amountTo: 10,
          transferDate: `${M2}-10`,
        },
        ctx(),
      ),
    ).rejects.toThrow('same_account');
  });
});

describe('recurring fixed costs', () => {
  it('posts a month once, and pressing again changes nothing', async () => {
    const category = await saveCategory(
      { name: `Oylik test ${SUFFIX}`, cash: true, sortOrder: 30, active: true },
      ctx(),
    );
    await saveRecurring(
      {
        categoryId: category.id,
        amount: 700,
        currency: 'USD',
        dayOfMonth: 5,
        active: true,
      },
      ctx(),
    );
    for (const date of [`${M2}-05`]) {
      await db
        .insert(fxRates)
        .values({ currency: 'USD', rateToUsd: '1', effectiveDate: date, enteredBy: actorId })
        .onConflictDoNothing();
    }

    const first = await generateRecurring(M2, ctx());
    expect(first.created).toBeGreaterThanOrEqual(1);
    const second = await generateRecurring(M2, ctx());
    expect(second.created).toBe(0);

    const posted = await db
      .select()
      .from(expenses)
      .where(sql`${expenses.categoryId} = ${category.id} AND ${expenses.voidedAt} IS NULL`);
    expect(posted).toHaveLength(1);
    expect(Number(posted[0]!.amountUsd)).toBe(700);
  });

  it('rejects a malformed month rather than guessing', async () => {
    await expect(generateRecurring('2031-3', ctx())).rejects.toThrow('bad_month');
  });
});

describe('profitability', () => {
  it('per client: charges minus the costs allocated to that client', async () => {
    const rows = await profitByClient(`${M2}-01`, `${M2}-28`);
    const row = rows.find((entry) => entry.clientId === clientId)!;
    expect(row.revenueUsd).toBe(5000);
    expect(row.profitUsd).toBe(row.revenueUsd - row.costUsd);
    expect(row.marginPct).toBe(
      Math.round((row.profitUsd / row.revenueUsd) * 1000) / 10,
    );
  });
});
