import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  accountTransfers,
  batches,
  clientTransactions,
  clients,
  costEntries,
  costTypes,
  currencies,
  expenseCategories,
  expenses,
  fxRates,
  moneyAccounts,
  partnerTransactions,
  partnerTypes,
  partners,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { addCostEntry, fillKassaUsd, setCostAccount } from '@/modules/wms/costing/service';
import { accountBalancesBetween, addExpense, addTransfer } from '@/modules/wms/accounting/service';
import { mergeDuplicate } from '@/modules/wms/accounting/cost-merge';
import {
  cashFlow,
  cashFlowByMonth,
  cashReconciliation,
  pnlGaps,
  profitAndLoss,
} from '@/modules/wms/accounting/reports';
import { recordSettlement } from '@/modules/wms/partners/settlement';

/**
 * «Kurs farqi (kassa)» — the owner's Q13 A and Q12 A (0103): a kassa-paid cost
 * keeps its tannarx at the table rate and its PAYMENT at what left the kassa,
 * the difference is the P&L's FX line and the cash flow's exchange row, and a
 * transfer's spread is the same kind of fact. Every scenario is the design's
 * (B1-B11).
 *
 * The year is 1611, dated by nothing else; the currencies are this file's own
 * (ZK*), one flat rate for all of history unless a test says otherwise, and
 * removed at the end — a rate is CONFIGURATION every later conversion reads
 * (#380, #183).
 */

const STAMP = String(Date.now()).slice(-6);
const CNYLIKE = 'ZKA'; // 0.14
const SOMLIKE = 'ZKB'; // 1/13,000
const UNRATED = 'ZKC'; // no rate until a test gives it one
const SOM2 = 'ZKD'; // 1/13,500
const UNRATED2 = 'ZKE';
const OWN = [CNYLIKE, SOMLIKE, UNRATED, SOM2, UNRATED2];
let actorId = '';
let costTypeId = '';
let cashCategory = '';
let batchId = '';
let clientId = '';
let partnerId = '';
const madeWarehouses: string[] = [];
const madeTills: string[] = [];
const madeCosts: string[] = [];
const madeExpenses: string[] = [];
const ctx = () => ({ actorId });
const cents = (value: number) => Math.round(value * 100) / 100;

async function till(name: string, currency: string) {
  const [row] = await db.insert(moneyAccounts).values({ name: `FX ${name} ${STAMP}`, currency }).returning();
  madeTills.push(row!.id);
  return row!.id;
}

async function cost(amount: number, currency: string, costDate: string, over: Record<string, unknown> = {}) {
  const entry = await addCostEntry(
    { scope: 'batch', batchId, costTypeId, amount, currency, costDate, allocationBasis: 'weight', ...over },
    ctx(),
  );
  madeCosts.push(entry.id);
  return entry.id;
}

async function row(id: string) {
  const [found] = await db.select().from(costEntries).where(eq(costEntries.id, id));
  return found!;
}

const fxOf = async (key: string, from: string, to: string) =>
  (await profitAndLoss(from, to)).fx.find((line) => line.key === key)?.total ?? 0;

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  costTypeId = (await db.select({ id: costTypes.id }).from(costTypes).limit(1))[0]!.id;
  cashCategory = (await db.insert(expenseCategories).values({ name: `FX naqd ${STAMP}` }).returning())[0]!.id;
  for (const code of OWN) {
    await db.insert(currencies).values({ code, name: `FX ${code}`, active: false }).onConflictDoNothing();
  }
  for (const [currency, rate] of [
    [CNYLIKE, '0.14'],
    [SOMLIKE, '0.000076923077'],
    [SOM2, '0.000074074074'],
  ] as const) {
    await db
      .insert(fxRates)
      .values({ currency, rateToUsd: rate, effectiveDate: '1600-01-01', enteredBy: actorId })
      .onConflictDoNothing();
  }
  for (const [code, country] of [
    [`FQ${STAMP}`, 'CN'],
    [`FR${STAMP}`, 'UZ'],
  ] as const) {
    const [wh] = await db
      .insert(warehouses)
      .values({ code, batchPrefix: code, name: code, country, type: 'origin', timezone: 'Asia/Shanghai' })
      .returning();
    madeWarehouses.push(wh!.id);
  }
  batchId = uuidv4();
  await db.insert(batches).values({
    id: batchId,
    code: `FQ${STAMP}-001`,
    originWarehouseId: madeWarehouses[0]!,
    destWarehouseId: madeWarehouses[1]!,
    status: 'forming',
    createdBy: actorId,
  });
  clientId = (await db.insert(clients).values({ clientCode: `FR${STAMP}`, name: `FX mijoz ${STAMP}` }).returning())[0]!
    .id;
  const [type] = await db.select().from(partnerTypes).limit(1);
  partnerId = (
    await db.insert(partners).values({ name: `FX firma ${STAMP}`, typeId: type!.id, createdBy: actorId }).returning()
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(partnerTransactions).where(eq(partnerTransactions.partnerId, partnerId));
  await db.delete(clientTransactions).where(eq(clientTransactions.clientId, clientId));
  if (madeCosts.length) await db.delete(costEntries).where(inArray(costEntries.id, madeCosts));
  if (madeExpenses.length) await db.delete(expenses).where(inArray(expenses.id, madeExpenses));
  if (madeTills.length) {
    await db.delete(accountTransfers).where(inArray(accountTransfers.fromAccountId, madeTills));
    await db.delete(accountTransfers).where(inArray(accountTransfers.toAccountId, madeTills));
    await db.delete(moneyAccounts).where(inArray(moneyAccounts.id, madeTills));
  }
  await db.delete(partners).where(eq(partners.id, partnerId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await db.delete(batches).where(eq(batches.id, batchId));
  await db.delete(warehouses).where(inArray(warehouses.id, madeWarehouses));
  await db.delete(expenseCategories).where(eq(expenseCategories.id, cashCategory));
  await db.delete(fxRates).where(inArray(fxRates.currency, OWN));
  await db.delete(currencies).where(inArray(currencies.code, OWN));
  await pgClient.end();
});

describe('a kassa-paid cost keeps its tannarx and its payment apart (Q13 A)', () => {
  it('B1: a ¥20,000 truck paid $2,850 out of a dollar kassa — tannarx $2,800, «Kurs farqi (kassa)» −$50', async () => {
    const usdTill = await till('USD B1', 'USD');
    const id = await cost(20_000, CNYLIKE, '1611-02-10', { accountId: usdTill, accountAmount: 2850 });
    expect(await row(id)).toMatchObject({ amountUsd: '2800.00', accountAmountUsd: '2850.00', accountRateUsed: '1.000000000000' });

    const pnl = await profitAndLoss('1611-02-01', '1611-02-28');
    expect(pnl.directTotal.total).toBe(2800);
    expect(pnl.fx.find((line) => line.key === 'fx:kassa')!.total).toBe(-50);
    expect(pnl.fxTotal.total).toBe(-50);
    // The owner's Q12 A: the net includes the line.
    expect(pnl.netProfit.total).toBe(cents(pnl.grossProfit.total - pnl.opexTotal.total + pnl.fxTotal.total));
    expect(pnl.netProfit.total).toBe(-2850);

    const flow = await cashFlow('1611-02-01', '1611-02-28');
    expect(flow.rows.find((r) => r.label === 'cargoCosts')!.amountUsd).toBe(2800);
    expect(flow.rows.find((r) => r.label === 'fxLoss')!.amountUsd).toBe(50);
    expect(flow.outflow).toBe(2850);
    // …and the kassa's own dollars say the same (cash-rules.ts' identity).
    const kassa = (await accountBalancesBetween('1611-02-01', '1611-02-28')).find((k) => k.id === usdTill)!;
    expect(cents(kassa.usd.cashCounted)).toBe(-2850);
  });

  it('B2: a $100 cost paid 1,352,000 out of a so\'m kassa counts $104 — the same as the same so\'m typed as an expense', async () => {
    const somTill = await till('SOM B2', SOMLIKE);
    const id = await cost(100, 'USD', '1611-04-10', { accountId: somTill, accountAmount: 1_352_000 });
    expect(await row(id)).toMatchObject({ amountUsd: '100.00', accountAmountUsd: '104.00' });
    const asExpense = await addExpense(
      { categoryId: cashCategory, amount: 1_352_000, currency: SOMLIKE, expenseDate: '1611-04-11', accountId: somTill },
      ctx(),
    );
    madeExpenses.push(asExpense.id);
    expect(Number(asExpense.amountUsd)).toBe(104);
    const flow = await cashFlow('1611-04-10', '1611-04-10');
    expect(flow.outflow).toBe(104);
    expect(flow.fxKassaCostUsd).toBe(-4);
  });

  it('B3: a merged cost pays at the EXPENSE\'s dollars — $980 of tannarx, $1,000 out of the drawer', async () => {
    const somTill = await till('SOM B3', SOMLIKE);
    const id = await cost(980, 'USD', '1611-03-02');
    const ex = await addExpense(
      { categoryId: cashCategory, amount: 13_000_000, currency: SOMLIKE, expenseDate: '1611-02-26', accountId: somTill },
      ctx(),
    );
    madeExpenses.push(ex.id);
    await mergeDuplicate({ costIds: [id], expenseId: ex.id }, ctx());
    expect(await row(id)).toMatchObject({ accountAmount: '13000000.00', accountAmountUsd: '1000.00' });

    // The P&L: the cost in March (its own day), the exchange difference in
    // February (the day the DRAWER paid — the cash flow's day, B7).
    expect(await fxOf('fx:kassa', '1611-02-20', '1611-02-28')).toBe(-20);
    const march = await profitAndLoss('1611-03-01', '1611-03-31');
    expect(march.directTotal.total).toBe(980);
    expect(march.opexTotal.total).toBe(0);
    const flow = await cashFlow('1611-02-20', '1611-02-28');
    expect(flow.rows.find((r) => r.label === 'cargoCosts')!.amountUsd).toBe(980);
    expect(flow.rows.find((r) => r.label === 'fxLoss')!.amountUsd).toBe(20);
  });

  it('B4: a transfer buys so\'m at another rate — the spread is realised FX, and the reconciliation still closes', async () => {
    const usdTill = await till('USD B4', 'USD');
    const somTill = await till('SOM B4', SOM2);
    const transfer = await addTransfer(
      { fromAccountId: usdTill, toAccountId: somTill, amountFrom: 1000, amountTo: 13_000_000, transferDate: '1611-05-10' },
      ctx(),
    );
    expect(transfer.amountToUsd).toBe('962.96');
    expect(await fxOf('fx:kassa', '1611-05-01', '1611-05-31')).toBe(-37.04);
    const recon = await cashReconciliation('1611-05-01', '1611-05-31');
    expect(recon.flow.rows.find((r) => r.label === 'fxLoss')!.amountUsd).toBe(37.04);
    expect(recon.flow.fxTransferUsd).toBe(-37.04);
    expect(recon.unexplained).toBe(0);
  });

  it('B5: a cost out of a kassa whose currency has no rate waits, is filled ONCE, and a second rate moves nothing', async () => {
    const unratedTill = await till('UNRATED B5', UNRATED);
    const id = await cost(200, 'USD', '1611-06-10', { accountId: unratedTill, accountAmount: 2_600_000 });
    expect(await row(id)).toMatchObject({ amountUsd: '200.00', accountAmountUsd: null, accountRateUsed: null });
    expect((await pnlGaps('1611-06-01', '1611-06-30')).kassaUsdMissing.count).toBe(1);

    await db.insert(fxRates).values({ currency: UNRATED, rateToUsd: '0.0001', effectiveDate: '1600-01-01', enteredBy: actorId });
    await fillKassaUsd();
    expect(await row(id)).toMatchObject({ accountAmountUsd: '260.00', accountRateUsed: '0.000100000000' });
    expect((await pnlGaps('1611-06-01', '1611-06-30')).kassaUsdMissing.count).toBe(0);

    // A later rate for the same day: the payment keeps the dollars it was
    // converted at (Q18) — the fill is a claim on an EMPTY column.
    await db.insert(fxRates).values({ currency: UNRATED, rateToUsd: '0.0002', effectiveDate: '1611-06-01', enteredBy: actorId });
    await fillKassaUsd();
    expect((await row(id)).accountAmountUsd).toBe('260.00');
  });

  it('B6: a three-cornered settlement\'s gap is the P&L\'s, and the cash flow does not see it', async () => {
    const before = await cashFlow('1611-07-01', '1611-07-31');
    await recordSettlement(
      {
        txId: uuidv4(),
        clientId,
        partnerId,
        clientAmount: 7000,
        clientCurrency: CNYLIKE,
        partnerAmount: 1000,
        partnerCurrency: 'USD',
        txDate: '1611-07-10',
        note: 'FX B6',
      },
      ctx(),
    );
    expect(await fxOf('fx:settlement', '1611-07-01', '1611-07-31')).toBe(20);
    expect((await cashFlow('1611-07-01', '1611-07-31')).inflow).toBe(before.inflow);
  });

  it('B7: the P&L\'s «Kurs farqi (kassa)» and the cash flow\'s exchange rows agree month by month', async () => {
    const pnl = await profitAndLoss('1611-01-01', '1611-12-31');
    const kassaLine = pnl.fx.find((line) => line.key === 'fx:kassa')!;
    const flow = await cashFlowByMonth('1611-01-01', '1611-12-31');
    for (const month of pnl.months) {
      const parts = flow.get(month)!;
      expect(kassaLine.byPeriod[month] ?? 0, month).toBe(cents(parts.fxGain - parts.fxLoss));
    }
    expect(kassaLine.byPeriod['1611-02']).toBe(-70); // B1 −50 + B3 −20 (its drawer day)
  });

  it('B10: a transfer into a till with no rate is never refused — its FX waits for the rate', async () => {
    const usdTill = await till('USD B10', 'USD');
    const unratedTill = await till('UNRATED B10', UNRATED2);
    const transfer = await addTransfer(
      { fromAccountId: usdTill, toAccountId: unratedTill, amountFrom: 500, amountTo: 5_000_000, transferDate: '1611-08-10' },
      ctx(),
    );
    expect(transfer.amountToUsd).toBeNull();
    expect((await pnlGaps('1611-08-01', '1611-08-31')).transferUsdMissing.count).toBe(1);
    await db.insert(fxRates).values({ currency: UNRATED2, rateToUsd: '0.0001', effectiveDate: '1600-01-01', enteredBy: actorId });
    await fillKassaUsd();
    const [stored] = await db.select().from(accountTransfers).where(eq(accountTransfers.id, transfer.id));
    expect(stored!.amountToUsd).toBe('500.00');
    expect((await pnlGaps('1611-08-01', '1611-08-31')).transferUsdMissing.count).toBe(0);
  });

  it('B11: a same-currency kassa takes the tannarx the ROW holds when it is placed, not the one read before', async () => {
    const cnyTill = await till('CNY B11', CNYLIKE);
    const id = await cost(10_000, CNYLIKE, '1611-09-10'); // the queue: no kassa yet
    expect((await row(id)).amountUsd).toBe('1400.00');

    const helper = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', {
      max: 1,
      onnotice: () => {},
    });
    const held = await helper.reserve();
    try {
      await held`BEGIN`;
      await held`SELECT id FROM cost_entries WHERE id = ${id} FOR UPDATE`;
      // A corrected rate re-pricing the tannarx, committing while the
      // accountant's press is in flight.
      await held`UPDATE cost_entries SET amount_usd = 1300, fx_rate_used = 0.13 WHERE id = ${id}`;
      const placing = setCostAccount(id, cnyTill, undefined, ctx());
      let waiting = false;
      for (let i = 0; i < 250 && !waiting; i += 1) {
        const rows = await db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND query ILIKE '%cost_entries%' AND pid <> pg_backend_pid()`);
        waiting = Number(rows[0]?.n ?? 0) > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 20));
      }
      expect(waiting, 'the placing press never reached the row lock').toBe(true);
      await held`COMMIT`;
      await placing;
    } finally {
      held.release();
      await helper.end();
    }
    expect(await row(id)).toMatchObject({ amountUsd: '1300.00', accountAmountUsd: '1300.00' });
    expect(await fxOf('fx:kassa', '1611-09-01', '1611-09-30')).toBe(0);
  });
});
