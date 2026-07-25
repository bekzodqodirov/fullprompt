import 'dotenv/config';
import ExcelJS from 'exceljs';
import { eq, sql } from 'drizzle-orm';
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
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, ingestLoadScans } from '@/modules/wms/scanning/service';
import { addCostEntry } from '@/modules/wms/costing/service';
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
  profitByBatch,
  profitByClient,
  profitByRoute,
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
  // The P&L is a period query with no client filter, so anything an earlier
  // run left in this year would add to the totals. The year is far in the
  // future and belongs to nobody, so clearing it is safe and makes the run
  // idempotent even when two runs land on the same year.
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

    const today = new Date().toISOString().slice(0, 10);
    await db
      .insert(fxRates)
      .values({ currency: 'USD', rateToUsd: '1', effectiveDate: today, enteredBy: actorId })
      .onConflictDoNothing();
    await addCostEntry(
      {
        scope: 'batch',
        batchId: batch!.id,
        costTypeId: (await db.select().from(costTypes).limit(1))[0]!.id,
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
    const asOf = new Date().toISOString().slice(0, 10);
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
