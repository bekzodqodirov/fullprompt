import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
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
  moneyAccounts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { cashFlow, cashFlowByMonth, cashFlowByWeek, type CashParts } from '@/modules/wms/accounting/reports';
import { addDays } from '@/modules/platform/time/tashkent';

/**
 * The cash flow week by week (the dashboard's twelve columns) is the cash flow
 * report, bucketed — ONE core, ONE bucket expression for the drizzle selects
 * AND the raw kurs farqi union (the data lens's main risk: a unit taught to
 * one and not the other leaves the exchange rows on another key, and the weeks
 * drop them without a sound). Built like the monthly fence in
 * `dashboard.integration.test.ts`, plus the rows that only the raw union
 * reads: a transfer's spread, a kassa-paid cost's exchange difference, and a
 * kassa payment for a cost whose own currency has no rate.
 *
 * Money lives in 1657-07 so no other file's period reads it; the unrated
 * currency is this file's own (ZDW), with no rate, so no sweep another file
 * runs can convert it mid-test. July 1657: the 1st and the 8th are Sundays,
 * the Mondays are 2, 9, 16, 23 and 30. Cleanup is the LAST TEST, not an
 * `afterAll` that can silently do nothing (#183).
 */

const STAMP = `${Date.now()}`.slice(-6);
const FROM = '1657-07-01';
const TO = '1657-07-31';
const UNRATED = 'ZDW';
let actorId = '';
let categoryId = '';
let clientId = '';
let costTypeId = '';
let batchId = '';
const tills: string[] = [];
const whs: string[] = [];
const costs: string[] = [];
const transfers: string[] = [];

async function till(name: string) {
  const [row] = await db
    .insert(moneyAccounts)
    .values({ name: `DashWeeks ${name} ${STAMP}`, currency: 'USD' })
    .returning({ id: moneyAccounts.id });
  tills.push(row!.id);
  return row!.id;
}

async function money(type: 'payment' | 'refund', usd: number, day: string) {
  await db.insert(clientTransactions).values({
    clientId,
    type,
    amount: String(usd),
    currency: 'USD',
    rateToUsd: '1',
    amountUsd: String(usd),
    txDate: day,
    accountId: tills[0]!,
    createdBy: actorId,
  });
}

/** A kassa-paid cost with both dollar figures stated (null = unrated), inserted as the columns say. */
async function kassaCost(day: string, currency: string, amount: number, amountUsd: number | null, kassaUsd: number) {
  const [row] = await db
    .insert(costEntries)
    .values({
      scope: 'batch',
      batchId,
      costTypeId,
      amount: String(amount),
      currency,
      amountUsd: amountUsd === null ? null : String(amountUsd),
      fxRateUsed: amountUsd === null ? null : '1',
      costDate: day,
      allocationBasis: 'weight',
      accountId: tills[0]!,
      accountAmount: String(kassaUsd),
      accountAmountUsd: String(kassaUsd),
      accountRateUsed: '1',
      enteredBy: actorId,
    })
    .returning({ id: costEntries.id });
  costs.push(row!.id);
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  categoryId = (
    await db
      .select({ id: expenseCategories.id })
      .from(expenseCategories)
      .where(eq(expenseCategories.cash, true))
      .limit(1)
  )[0]!.id;
  costTypeId = (await db.select({ id: costTypes.id }).from(costTypes).limit(1))[0]!.id;
  await db.insert(currencies).values({ code: UNRATED, name: 'Dash weeks unrated', active: false }).onConflictDoNothing();
  for (const [code, country] of [
    [`DW${STAMP}`, 'CN'],
    [`DV${STAMP}`, 'UZ'],
  ] as const) {
    const [wh] = await db
      .insert(warehouses)
      .values({ code, batchPrefix: code, name: `Dash weeks ${code}`, country, type: 'origin', timezone: 'Asia/Shanghai' })
      .returning({ id: warehouses.id });
    whs.push(wh!.id);
  }
  batchId = uuidv4();
  await db.insert(batches).values({
    id: batchId,
    code: `DW${STAMP}-001`,
    originWarehouseId: whs[0]!,
    destWarehouseId: whs[1]!,
    status: 'forming',
    createdBy: actorId,
  });
  clientId = (
    await db
      .insert(clients)
      .values({ clientCode: `DW${STAMP}`, name: `Dash weeks mijoz ${STAMP}` })
      .returning({ id: clients.id })
  )[0]!.id;
  await till('A');
  await till('B');

  // Outside the range: the day before it, which its own week (06-25) must not count.
  await money('payment', 999, '1657-06-30');
  // Week 06-25 — the range's first day alone, a Sunday.
  await money('payment', 1000, '1657-07-01');
  // Week 07-02: a Monday expense and a SUNDAY payment — the Sunday belongs here.
  await db.insert(expenses).values({
    categoryId,
    amount: '200',
    currency: 'USD',
    rateToUsd: '1',
    amountUsd: '200',
    expenseDate: '1657-07-02',
    accountId: tills[0]!,
    createdBy: actorId,
  });
  await money('payment', 500, '1657-07-08');
  // Week 07-09: a transfer whose to-side is worth $10 more — the raw union's spread.
  const [transfer] = await db
    .insert(accountTransfers)
    .values({
      fromAccountId: tills[0]!,
      toAccountId: tills[1]!,
      amountFrom: '300',
      amountTo: '300',
      amountUsd: '300',
      amountToUsd: '310',
      transferDate: '1657-07-10',
      createdBy: actorId,
    })
    .returning({ id: accountTransfers.id });
  transfers.push(transfer!.id);
  // Week 07-16: a cost the kassa paid $20 over its tannarx, and one whose own
  // currency has no rate — the kassa's $80 is the «unrated» line.
  await kassaCost('1657-07-17', 'USD', 400, 400, 420);
  await kassaCost('1657-07-18', UNRATED, 1000, null, 80);
  // Week 07-23: nothing at all. Week 07-30: a refund on the range's last day.
  await money('refund', 50, '1657-07-31');
});

afterAll(async () => {
  await pgClient.end();
});

const WEEKS = ['1657-06-25', '1657-07-02', '1657-07-09', '1657-07-16', '1657-07-23', '1657-07-30'];
const cents = (value: number) => Math.round(value * 100) / 100;

describe('the cash flow by week is the cash flow report, bucketed', () => {
  it('answers exactly the range\'s ISO weeks, an empty week a week of zeros', async () => {
    const weeks = await cashFlowByWeek(FROM, TO);
    expect([...weeks.keys()]).toEqual(WEEKS);
    expect(weeks.get('1657-07-23')).toMatchObject({ inflow: 0, outflow: 0, net: 0, fxGain: 0, cargoUnrated: 0 });
  });

  it('each week equals the report over that week, clipped to the range — kurs farqi and unrated included', async () => {
    const weeks = await cashFlowByWeek(FROM, TO);
    for (const week of WEEKS) {
      const from = week < FROM ? FROM : week;
      const end = addDays(week, 6);
      const to = end > TO ? TO : end;
      const report = await cashFlow(from, to);
      const part = weeks.get(week)!;
      expect(part.inflow, week).toBe(report.inflow);
      expect(part.outflow, week).toBe(report.outflow);
      expect(part.net, week).toBe(report.net);
      expect(part.fxTransfer, week).toBe(report.fxTransferUsd);
      expect(cents(part.fxGain - part.fxLoss - part.fxTransfer), week).toBe(report.fxKassaCostUsd);
      expect(part.cargoUnrated, week).toBe(report.cargoUnratedUsd);
    }
  });

  it('a Sunday falls in the week of the Monday before it, and the day before the range is not counted', async () => {
    const weeks = await cashFlowByWeek(FROM, TO);
    expect(weeks.get('1657-07-02')).toMatchObject({ clientPayments: 500, cashOpex: 200, net: 300 });
    expect(weeks.get('1657-06-25')).toMatchObject({ clientPayments: 1000, net: 1000 });
    expect(weeks.get('1657-07-09')).toMatchObject({ fxGain: 10, fxTransfer: 10, net: 10 });
    expect(weeks.get('1657-07-16')).toMatchObject({
      cargoCosts: 400,
      fxLoss: 20,
      cargoUnrated: 80,
      unconvertedCount: 1,
      net: -500,
    });
    expect(weeks.get('1657-07-30')).toMatchObject({ clientRefunds: 50, net: -50 });
  });

  it('the weeks add up to the range, field by field, the exchange and unrated rows included', async () => {
    const weeks = await cashFlowByWeek(FROM, TO);
    // The range is exactly July, so the monthly bucket is the range's own parts.
    const month = (await cashFlowByMonth(FROM, TO)).get('1657-07')!;
    for (const field of Object.keys(month) as (keyof CashParts)[]) {
      const summed = cents([...weeks.values()].reduce((sum, part) => sum + part[field], 0));
      expect(summed, field).toBe(month[field]);
    }
    const whole = await cashFlow(FROM, TO);
    expect(cents([...weeks.values()].reduce((sum, part) => sum + part.net, 0))).toBe(whole.net);
    expect(whole.net).toBe(cents(1000 + 500 - 200 + 10 - 400 - 20 - 80 - 50));
  });

  it('cleans up after itself (the last test, not an afterAll that can say nothing)', async () => {
    await db.delete(clientTransactions).where(eq(clientTransactions.clientId, clientId));
    await db.delete(expenses).where(inArray(expenses.accountId, tills));
    await db.delete(accountTransfers).where(inArray(accountTransfers.id, transfers));
    await db.delete(costEntries).where(inArray(costEntries.id, costs));
    await db.delete(moneyAccounts).where(inArray(moneyAccounts.id, tills));
    await db.delete(batches).where(eq(batches.id, batchId));
    await db.delete(clients).where(eq(clients.id, clientId));
    await db.delete(currencies).where(eq(currencies.code, UNRATED));
    // Warehouses are deactivated, never deleted (the audit log's FK, #738).
    await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, whs));

    const left = await db.execute(sql`
      SELECT (SELECT count(*) FROM money_accounts WHERE id IN (${sql.join(tills, sql`, `)}))::int AS tills,
             (SELECT count(*) FROM cost_entries WHERE id IN (${sql.join(costs, sql`, `)}))::int AS costs,
             (SELECT count(*) FROM currencies WHERE code = ${UNRATED})::int AS currency,
             (SELECT count(*) FROM warehouses WHERE id IN (${sql.join(whs, sql`, `)}) AND active)::int AS live_whs`);
    expect([...left][0]).toEqual({ tills: 0, costs: 0, currency: 0, live_whs: 0 });
    const july = await cashFlowByWeek(FROM, TO);
    expect([...july.values()].every((part) => part.inflow === 0 && part.outflow === 0)).toBe(true);
  });
});
