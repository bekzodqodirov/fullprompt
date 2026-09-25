import 'dotenv/config';
import ExcelJS from 'exceljs';
import { eq, sql, TransactionRollbackError } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxes,
  clients,
  costTypes,
  expenses,
  fxRates,
  moneyAccounts,
  partnerTransactions,
  partnerTypes,
  partners,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { reportLabels } from '@/modules/wms/reports/labels';
import { partnerBalanceUsd, savePartner, setPartnerActive } from '@/modules/wms/partners/service';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, ingestLoadScans } from '@/modules/wms/scanning/service';
import { addCostEntry, voidCostEntry } from '@/modules/wms/costing/service';
import {
  accountBalances,
  addExpense,
  addTransfer,
  generateRecurring,
  listExpenses,
  listTransfers,
  saveAccount,
  saveCategory,
  saveRecurring,
  updateRecurring,
  voidExpense,
} from '@/modules/wms/accounting/service';
import {
  buildCashFlowXlsx,
  buildExpensesXlsx,
  buildPnlXlsx,
  buildProfitXlsx,
  buildReceivablesXlsx,
} from '@/modules/wms/accounting/xlsx';
import {
  arAging,
  cashFlow,
  monthsBetween,
  profitAndLoss,
  companyBalance,
  profitByBatch,
  profitByClient,
  profitByRoute,
} from '@/modules/wms/accounting/reports';
import { addTransaction } from '@/modules/wms/finance/service';
import { tashkentDay } from '@/modules/platform/time/tashkent';

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
const YEAR = String(1700 + RUN);
const M1 = `${YEAR}-03`;
const M2 = `${YEAR}-04`;

beforeAll(async () => {
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  // The P&L is a period query with no client filter, so anything an earlier
  // run left in this year would add to the totals. The year is centuries in
  // the PAST and belongs to nobody, so clearing it is safe and makes the run
  // idempotent even when two runs land on the same year. (It was the future
  // until the ledger started refusing future-dated rows — audit A23.)
  await db.execute(sql`DELETE FROM client_transactions WHERE tx_date BETWEEN ${`${YEAR}-01-01`} AND ${`${YEAR}-12-31`}`);
  await db.execute(sql`DELETE FROM expenses WHERE expense_date BETWEEN ${`${YEAR}-01-01`} AND ${`${YEAR}-12-31`}`);
  await db.execute(sql`DELETE FROM account_transfers WHERE transfer_date BETWEEN ${`${YEAR}-01-01`} AND ${`${YEAR}-12-31`}`);

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
    const aging = await arAging(tashkentDay());
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

  it('two rents in one category, told apart by their warehouse — both post', async () => {
    // Two warehouse rents, same category, same day, no employee: the slot
    // check used to collide them — the first posted, the second reported
    // «already posted» every month for ever, and the home counter (which
    // mirrors the same predicate) said nothing was due.
    const category = await saveCategory(
      { name: `Ikki ijara ${SUFFIX}`, cash: true, sortOrder: 31, active: true },
      ctx(),
    );
    const whs = await db.select({ id: warehouses.id }).from(warehouses).limit(2);
    for (const [i, wh] of whs.entries()) {
      await saveRecurring(
        {
          categoryId: category.id,
          amount: 700 + i * 200,
          currency: 'USD',
          dayOfMonth: 6,
          warehouseId: wh.id,
          active: true,
        },
        ctx(),
      );
    }

    const run = await generateRecurring(M2, ctx());
    expect(run.created).toBe(2);
    // …and the guard still guards: a second press posts nothing.
    const again = await generateRecurring(M2, ctx());
    expect(again.created).toBe(0);

    const posted = await db
      .select()
      .from(expenses)
      .where(sql`${expenses.categoryId} = ${category.id} AND ${expenses.voidedAt} IS NULL`);
    expect(posted).toHaveLength(2);
  });

  it('a one-off on the payday slot does not stand in for the salary (audit A33)', async () => {
    const category = await saveCategory(
      { name: `Oylik ${SUFFIX}`, cash: true, sortOrder: 32, active: true },
      ctx(),
    );
    const salary = await saveRecurring(
      { categoryId: category.id, amount: 900, currency: 'USD', dayOfMonth: 7, active: true },
      ctx(),
    );
    // A bonus typed by hand on the same day, same category, same person.
    await addExpense(
      { categoryId: category.id, amount: 50, currency: 'USD', expenseDate: `${M2}-07` },
      ctx(),
    );
    const run = await generateRecurring(M2, ctx());
    expect(run.created).toBeGreaterThanOrEqual(1);
    const posted = await db
      .select()
      .from(expenses)
      .where(sql`${expenses.categoryId} = ${category.id} AND ${expenses.voidedAt} IS NULL`);
    // Before 0099: only the $50 — the $900 salary read as «already posted».
    expect(posted.map((row) => Number(row.amount)).sort((a, b) => a - b)).toEqual([50, 900]);
    // A live template is configuration every later press posts (#183).
    await updateRecurring(salary.id, { amount: 900, dayOfMonth: 7, active: false }, ctx());
  });

  it('a voided posting is «not this month», and a stopped template posts nothing (A32)', async () => {
    const category = await saveCategory(
      { name: `Eski ijara ${SUFFIX}`, cash: true, sortOrder: 33, active: true },
      ctx(),
    );
    const template = await saveRecurring(
      { categoryId: category.id, amount: 400, currency: 'USD', dayOfMonth: 8, active: true },
      ctx(),
    );
    await generateRecurring(M1, ctx());
    const [first] = await db
      .select()
      .from(expenses)
      .where(sql`${expenses.recurringId} = ${template.id} AND ${expenses.expenseDate} = ${`${M1}-08`}`);
    expect(first).toBeDefined();
    await voidExpense(first!.id, 'eski narx', ctx());
    // The next press used to post the same stale $400 again.
    const again = await generateRecurring(M1, ctx());
    const live = await db
      .select()
      .from(expenses)
      .where(sql`${expenses.recurringId} = ${template.id} AND ${expenses.voidedAt} IS NULL`);
    expect(live).toHaveLength(0);
    expect(again.skipped).toBeGreaterThanOrEqual(1);

    // Stopped on the row's own control: the next month posts nothing of it.
    await updateRecurring(template.id, { amount: 450, dayOfMonth: 8, active: false }, ctx());
    await generateRecurring(M2, ctx());
    const stopped = await db
      .select()
      .from(expenses)
      .where(sql`${expenses.recurringId} = ${template.id} AND ${expenses.expenseDate} = ${`${M2}-08`}`);
    expect(stopped).toHaveLength(0);
  });

  it('a template paid through a firm raises the firm\'s debt and touches no till (A36)', async () => {
    const category = await saveCategory(
      { name: `Xitoy ijara ${SUFFIX}`, cash: true, sortOrder: 34, active: true },
      ctx(),
    );
    const [type] = await db.select().from(partnerTypes).limit(1);
    const firm = await savePartner(
      null,
      { name: `Recurring firma ${SUFFIX}`, typeId: type!.id, clientId: '', phone: '', note: '' },
      ctx(),
    );
    const template = await saveRecurring(
      {
        categoryId: category.id,
        amount: 1200,
        currency: 'USD',
        dayOfMonth: 9,
        accountId,
        partnerId: firm,
        active: true,
      },
      ctx(),
    );
    expect(template.accountId).toBeNull();
    await generateRecurring(M2, ctx());
    const [posting] = await db
      .select()
      .from(expenses)
      .where(sql`${expenses.recurringId} = ${template.id}`);
    expect(posting!.partnerId).toBe(firm);
    expect(posting!.accountId).toBeNull();
    expect(await partnerBalanceUsd(firm)).toBe(1200);

    // Leave nothing live behind (#183): an active firm adds a payer picker to
    // every cost and expense form, an active template posts on every press.
    await voidExpense(posting!.id, 'sinov', ctx());
    await updateRecurring(template.id, { amount: 1200, dayOfMonth: 9, active: false }, ctx());
    await setPartnerActive(firm, false, ctx());
  });

  it("0099's backfill links the rows the old slot rule recognised, and only those", async () => {
    // The first press after the deploy must not post this month's rent a
    // second time: a posting from before the column existed is linked by the
    // migration — and a one-off with another amount is left alone.
    const category = await saveCategory(
      { name: `Backfill ${SUFFIX}`, cash: true, sortOrder: 35, active: true },
      ctx(),
    );
    const template = await saveRecurring(
      { categoryId: category.id, amount: 300, currency: 'USD', dayOfMonth: 11, active: false },
      ctx(),
    );
    const old = await addExpense(
      { categoryId: category.id, amount: 300, currency: 'USD', expenseDate: `${M1}-11` },
      ctx(),
    );
    const oneOff = await addExpense(
      { categoryId: category.id, amount: 25, currency: 'USD', expenseDate: `${M1}-11` },
      ctx(),
    );
    // The migration's own statement, run and rolled back — not a restatement.
    const migration = readFileSync('src/modules/platform/db/migrations/0099_recurring_link.sql', 'utf8');
    const backfill = migration.slice(migration.indexOf('UPDATE expenses e'));
    let seen: { id: string; recurringId: string | null }[] = [];
    await db
      .transaction(async (tx) => {
        await tx.execute(sql.raw(backfill));
        seen = await tx
          .select({ id: expenses.id, recurringId: expenses.recurringId })
          .from(expenses)
          .where(sql`${expenses.id} IN (${old.id}, ${oneOff.id})`);
        tx.rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof TransactionRollbackError)) throw err;
      });
    expect(seen.find((row) => row.id === old.id)!.recurringId).toBe(template.id);
    expect(seen.find((row) => row.id === oneOff.id)!.recurringId).toBeNull();
  });

  it('rejects a malformed month rather than guessing', async () => {
    await expect(generateRecurring('2031-3', ctx())).rejects.toThrow('bad_month');
  });
});

describe('profitability', () => {
  // Assigned by the per-batch test; the void tests below reuse the same batch.
  let profitBatchId: string;
  let profitCostTypeId: string;

  /**
   * Per batch: the report reads revenue, cost and box count through correlated
   * subqueries, and drizzle renders a column unqualified in a single-table
   * select — so a bare `id` inside them bound to the SUBQUERY's table and the
   * whole report came back as zeros (the box count died outright on
   * `uuid = bigint`). Every column below is pinned to a known figure.
   */
  it('per batch: its own revenue, its own costs, its own boxes', async () => {
    const wh = async (code: string, type: 'origin' | 'distribution') => {
      const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
      if (existing) return existing.id;
      const [row] = await db
        .insert(warehouses)
        .values({
          code,
          name: `Accounting ${code}`,
          country: type === 'origin' ? 'CN' : 'UZ',
          type,
          timezone: 'Asia/Tashkent',
          batchPrefix: code,
        })
        .returning();
      return row!.id;
    };
    const origin = await wh('ACWA', 'origin');
    const dest = await wh('ACWB', 'distribution');

    const lotId = uuidv4();
    await db.insert(attachments).values({
      entityType: 'receipt_lot',
      entityId: lotId,
      kind: 'photo',
      storageKey: `acc/${lotId}`,
      fileName: 'x.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1,
      uploadedBy: actorId,
    });
    await confirmReceipt(
      {
        receiptId: uuidv4(),
        warehouseId: origin,
        clientId,
        unclaimedMarking: '',
        lots: [
          {
            id: lotId,
            productNameZh: '利润货',
            boxCount: 2,
            dimsMode: 'uniform',
            boxLengthCm: 50,
            boxWidthCm: 40,
            boxHeightCm: 30,
            boxWeightKg: 25,
          },
        ],
        extraCosts: [],
      },
      ctx(),
    );
    const lotBoxes = await db.select().from(boxes).where(eq(boxes.lotId, lotId));

    const submitted = await submitPlan(
      { originWarehouseId: origin, destWarehouseId: dest, lines: [{ lotId, boxCount: 2 }] },
      ctx(),
    );
    const { batch } = await recordVerdict(
      { versionId: submitted.version.id, verdict: 'approved' },
      ctx(),
    );
    for (const box of lotBoxes) {
      await ingestLoadScans(
        [
          {
            clientEventUuid: uuidv4(),
            batchId: batch!.id,
            code: box.shortCode,
            method: 'qr' as const,
            addedOnSpot: false,
            scannedAt: new Date().toISOString(),
          },
        ],
        ctx(),
      );
    }
    await departBatch(batch!.id, ctx());

    const today = tashkentDay();
    await db
      .insert(fxRates)
      .values({ currency: 'USD', rateToUsd: '1', effectiveDate: today, enteredBy: actorId })
      .onConflictDoNothing();
    profitBatchId = batch!.id;
    profitCostTypeId = (await db.select().from(costTypes).limit(1))[0]!.id;
    await addCostEntry(
      {
        scope: 'batch',
        batchId: batch!.id,
        costTypeId: profitCostTypeId,
        amount: 400,
        currency: 'USD',
        costDate: today,
        allocationBasis: 'weight',
      },
      ctx(),
    );
    await addTransaction(
      {
        clientId,
        type: 'charge',
        amount: 1000,
        currency: 'USD',
        txDate: today,
        batchId: batch!.id,
      },
      ctx(),
    );

    const departedToday = await profitByBatch(today, today);
    const row = departedToday.find((entry) => entry.batchId === batch!.id)!;
    expect(row, 'the departed batch must appear').toBeDefined();
    expect(row.boxCount).toBe(2);
    expect(row.kg).toBe(50);
    expect(row.revenueUsd).toBe(1000);
    expect(row.costUsd).toBe(400);
    expect(row.profitUsd).toBe(600);
    expect(row.marginPct).toBe(60);
    expect(row.profitPerKg).toBe(12);
    expect(row.route).toBe('ACWA → ACWB');

    // The corridor roll-up must carry the same money through. Compared
    // against the batches on that corridor rather than a fixed number: an
    // earlier run may have left its own batch on the same route today.
    const onRoute = departedToday.filter((entry) => entry.route === 'ACWA → ACWB');
    const route = (await profitByRoute(today, today)).find((entry) => entry.route === 'ACWA → ACWB')!;
    const sum = (pick: (entry: (typeof onRoute)[number]) => number) =>
      Math.round(onRoute.reduce((acc, entry) => acc + pick(entry), 0) * 100) / 100;
    expect(route.batches).toBe(onRoute.length);
    expect(route.revenueUsd).toBe(sum((entry) => entry.revenueUsd));
    expect(route.costUsd).toBe(sum((entry) => entry.costUsd));
    expect(route.revenueUsd).toBeGreaterThanOrEqual(1000);
    // A receipt, a plan, two load scans, a departure and a cost allocation —
    // real work against a real database, well past the 5 s default.
  }, 30_000);

  it('per client: charges minus the costs allocated to that client', async () => {
    const rows = await profitByClient(`${M2}-01`, `${M2}-28`);
    const row = rows.find((entry) => entry.clientId === clientId)!;
    expect(row.revenueUsd).toBe(5000);
    expect(row.profitUsd).toBe(row.revenueUsd - row.costUsd);
    expect(row.marginPct).toBe(
      Math.round((row.profitUsd / row.revenueUsd) * 1000) / 10,
    );
  });

  /**
   * A voided cargo cost went on shrinking the profit for ever: the revenue
   * and opex sides of every report excluded their voided rows, direct costs
   * did not. Deltas rather than absolutes, because today's month is shared
   * with whatever else lives in the database.
   */
  it('a voided cargo cost drops out of the P&L, the cash flow and the batch profit', async () => {
    const today = tashkentDay();
    const round = (value: number) => Math.round(value * 100) / 100;
    const snapshot = async () => ({
      direct: (await profitAndLoss(today, today)).directTotal.total,
      cargo: (await cashFlow(today, today)).rows.find((row) => row.label === 'cargoCosts')!
        .amountUsd,
      batchCost: (await profitByBatch(today, today)).find(
        (row) => row.batchId === profitBatchId,
      )!.costUsd,
    });

    const before = await snapshot();
    const entry = await addCostEntry(
      {
        scope: 'batch',
        batchId: profitBatchId,
        costTypeId: profitCostTypeId,
        amount: 111,
        currency: 'USD',
        costDate: today,
        allocationBasis: 'weight',
      },
      ctx(),
    );
    const live = await snapshot();
    expect(live.direct).toBe(round(before.direct + 111));
    expect(live.cargo).toBe(round(before.cargo + 111));
    expect(live.batchCost).toBe(round(before.batchCost + 111));

    await voidCostEntry(entry.id, 'ikki marta kiritilgan', ctx());
    const after = await snapshot();
    expect(after.direct).toBe(before.direct);
    expect(after.cargo).toBe(before.cargo);
    expect(after.batchCost).toBe(before.batchCost);
  });

  /**
   * Voiding updates the entry and deletes its allocations in two statements,
   * not one transaction — an allocation orphaned by a crash between them must
   * still not be counted (the per-client report joins through the entry).
   */
  it('an allocation orphaned by a crash mid-void is not counted per client', async () => {
    const today = tashkentDay();
    const entry = await addCostEntry(
      {
        scope: 'batch',
        batchId: profitBatchId,
        costTypeId: profitCostTypeId,
        amount: 77,
        currency: 'USD',
        costDate: today,
        allocationBasis: 'weight',
      },
      ctx(),
    );
    const withCost = (await profitByClient(today, today)).find(
      (row) => row.clientId === clientId,
    )!;

    // The crash window: the entry is voided, its allocations survive.
    await db.execute(
      sql`UPDATE cost_entries SET voided_at = now(), voided_by = ${actorId}, void_reason = 'crash test' WHERE id = ${entry.id}`,
    );
    const orphans = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM cost_allocations WHERE cost_entry_id = ${entry.id}`,
    );
    expect(Number(orphans[0]!.n)).toBeGreaterThan(0);

    const after = (await profitByClient(today, today)).find(
      (row) => row.clientId === clientId,
    )!;
    expect(after.costUsd).toBe(Math.round((withCost.costUsd - 77) * 100) / 100);
  });
  it('a client whose period holds only COSTS still appears in profit-by-client', async () => {
    // Routine on live data: costs are booked at receipt and load, the price
    // agreed the month after. Keyed on revenue rows alone, the report dropped
    // the client entirely — the totals row was short the real cost and total
    // profit read high by exactly that much, while the P&L on the same hub
    // counted every entry by cost_date.
    const entry = await addCostEntry(
      {
        scope: 'batch',
        batchId: profitBatchId,
        costTypeId: profitCostTypeId,
        amount: 77,
        currency: 'USD',
        costDate: '2031-01-15',
        allocationBasis: 'weight',
      },
      ctx(),
    );
    const rows = await profitByClient('2031-01-01', '2031-01-31');
    const mine = rows.find((row) => row.clientId === clientId);
    expect(mine).toBeTruthy();
    expect(mine!.revenueUsd).toBe(0);
    expect(mine!.costUsd).toBe(77);
    expect(mine!.profitUsd).toBe(-77);
    await voidCostEntry(entry.id, 'davr testi tugadi', ctx());
  });


});

describe('a cash box speaks one currency', () => {
  it('refuses money in the wrong currency for the till it names', async () => {
    // One slip of an 86-option dropdown: 500 USD into a som till reads as
    // 500 SOM on the accounts screen — ~$500 quietly gone from the Balans,
    // with the client ledger still right and nothing anywhere flagging it.
    const [till] = await db
      .insert(moneyAccounts)
      .values({
        name: `USD kassa ${SUFFIX}`,
        currency: 'USD',
        kind: 'cash',
        openingBalance: '0',
        sortOrder: 951,
        active: true,
      })
      .returning();
    await expect(
      addTransaction(
        {
          clientId,
          type: 'payment',
          amount: 500,
          currency: 'UZS',
          txDate: tashkentDay(),
          accountId: till!.id,
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'account_currency_mismatch' });
    await db.delete(moneyAccounts).where(eq(moneyAccounts.id, till!.id));
  });
});

describe('the Balans and retired tills', () => {
  it('a retired cash box with money in it stays on the Balans', async () => {
    // The partner register\'s lesson (#428) on the accounts side: hiding a
    // till is a menu decision; deleting its balance from the sheet is a lie
    // about what the company holds.
    const [account] = await db
      .insert(moneyAccounts)
      .values({
        name: `Eski kassa ${SUFFIX}`,
        currency: 'USD',
        kind: 'cash',
        openingBalance: '250',
        sortOrder: 950,
        active: false,
      })
      .returning();

    const balance = await companyBalance();
    const row = balance.cashRows.find((r) => r.id === account!.id);
    expect(row).toBeTruthy();
    expect(row!.retired).toBe(true);
    expect(row!.balance).toBe(250);

    await db.delete(moneyAccounts).where(eq(moneyAccounts.id, account!.id));
  });
});

describe('transfers', () => {
  it('are listed with both sides named, so a move can be read back', async () => {
    const rows = await listTransfers();
    const row = rows.find((entry) => entry.fromName === `Kassa test ${SUFFIX}`)!;
    expect(row).toBeDefined();
    expect(row.toName).toBe(`Bank test ${SUFFIX}`);
    expect(Number(row.transfer.amountFrom)).toBe(150);
  });
});

describe('XLSX exports', () => {
  /** Read a built file back the way Excel would, not the way we wrote it. */
  const open = async (buffer: Buffer) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    return workbook;
  };
  const cells = (sheet: ExcelJS.Worksheet) => {
    const out: unknown[][] = [];
    sheet.eachRow((row) => out.push((row.values as unknown[]).slice(1)));
    return out;
  };

  it('P&L carries the same net profit as the screen', async () => {
    const pnl = await profitAndLoss(`${M2}-01`, `${M2}-28`);
    const rows = cells((await open(await buildPnlXlsx(`${M2}-01`, `${M2}-28`, 'uz'))).worksheets[0]!);
    const net = rows.find((row) => String(row[0]).toUpperCase().includes('FOYDA') && row.includes(pnl.netProfit.total));
    expect(net, 'net profit row').toBeDefined();
    // Month column header, so a reader can tell which period they are holding.
    expect(rows.some((row) => row.includes(M2))).toBe(true);
  });

  it('the P&L file names what the screen names: a hand-typed partner debt no cost row carries (U22)', async () => {
    const L = reportLabels('uz');
    const [type] = await db.select().from(partnerTypes).limit(1);
    const [partner] = await db
      .insert(partners)
      .values({ name: `Qo'lda qarz ${SUFFIX}`, typeId: type!.id, createdBy: actorId })
      .returning();
    // The legacy shape: a charge typed on the partner's card with no cost or
    // expense behind it — written directly, the card door is closed (#999).
    await db.insert(partnerTransactions).values({
      partnerId: partner!.id,
      type: 'charge',
      amount: '75',
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: '75',
      txDate: `${M2}-05`,
      createdBy: actorId,
    });
    try {
      const rows = cells((await open(await buildPnlXlsx(`${M2}-01`, `${M2}-28`, 'uz'))).worksheets[0]!);
      const note = rows.find((row) => String(row[0]).startsWith(`⚠ ${L.gapManualCharges}`));
      expect(note, 'the manual-charge warning').toBeDefined();
      // One text cell: a figure beside it would be summed with the report.
      expect(note!.filter((cell) => cell !== undefined && cell !== null && cell !== '').length).toBe(1);
      // The net row is still found the way the file's reader finds it.
      const pnl = await profitAndLoss(`${M2}-01`, `${M2}-28`);
      expect(rows.some((row) => String(row[0]).toUpperCase().includes('FOYDA') && row.includes(pnl.netProfit.total))).toBe(true);
    } finally {
      await db.delete(partnerTransactions).where(eq(partnerTransactions.partnerId, partner!.id));
      await db.delete(partners).where(eq(partners.id, partner!.id));
    }
  });

  it('the expense register totals what it lists', async () => {
    const rows = cells((await open(await buildExpensesXlsx(`${M2}-01`, `${M2}-28`, undefined, 'ru'))).worksheets[0]!);
    const listed = await listExpenses({ from: `${M2}-01`, to: `${M2}-28`, limit: 5000 });
    const expected =
      Math.round(listed.reduce((acc, row) => acc + Number(row.expense.amountUsd), 0) * 100) / 100;
    expect(rows.at(-1)![4]).toBe(expected);
    // Title, header, one row per expense, total (the blank spacer row is not
    // emitted by eachRow).
    expect(rows.length).toBe(listed.length + 3);
  });

  it('receivables export matches the ageing report', async () => {
    const asOf = tashkentDay();
    const aging = await arAging(asOf);
    const rows = cells((await open(await buildReceivablesXlsx(asOf, 'en'))).worksheets[0]!);
    const debtor = aging.find((row) => row.clientCode === `AD${SUFFIX}`)!;
    expect(rows.some((row) => row[0] === debtor.clientCode && row[2] === debtor.balance)).toBe(true);
  });

  it('every sheet name survives Excel', async () => {
    // A bilingual label with a slash once made every manifest download 500;
    // Excel refuses \ / ? * [ ] : in a tab name.
    const buffers = await Promise.all([
      buildPnlXlsx(`${M2}-01`, `${M2}-28`),
      buildCashFlowXlsx(`${M2}-01`, `${M2}-28`),
      buildReceivablesXlsx(`${M2}-28`),
      buildProfitXlsx('batch', `${M2}-01`, `${M2}-28`),
      buildProfitXlsx('client', `${M2}-01`, `${M2}-28`),
      buildProfitXlsx('route', `${M2}-01`, `${M2}-28`),
      buildExpensesXlsx(`${M2}-01`, `${M2}-28`, undefined),
    ]);
    for (const buffer of buffers) {
      expect(buffer.byteLength).toBeGreaterThan(0);
      const workbook = await open(buffer);
      for (const sheet of workbook.worksheets) expect(sheet.name).not.toMatch(/[\\/?*[\]:]/);
    }
  });
});
