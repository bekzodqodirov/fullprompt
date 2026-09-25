import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
import { addCostEntry, setCostAccount, setCostStaffPayer } from '@/modules/wms/costing/service';
import { accountBalancesBetween, addExpense, addTransfer } from '@/modules/wms/accounting/service';
import {
  cashFlow,
  cashFlowByMonth,
  cashReconciliation,
  companyBalance,
} from '@/modules/wms/accounting/reports';
import { addTransaction, paymentsRegister, placePayment } from '@/modules/wms/finance/service';
import { recordSettlement } from '@/modules/wms/partners/settlement';
import { moneyFlowCounts } from '@/modules/wms/home/role-flows';
import { moneySnapshot } from '@/modules/wms/reports/overview';
import { addDays, tashkentDay, tashkentMonthStart } from '@/modules/platform/time/tashkent';

/**
 * What the money REPORTS say (audit 2026-09-25): the cash flow's kassa
 * reconciliation (U13), its unconverted costs (U24), the Balans's kassa-less
 * costs (U02) and unrated tills (U14), and which kassa-less payment is still
 * money to place (U09).
 *
 * Periods live in 1640-1643, a stretch no other file dates anything in, so a
 * whole-period report here reads this file's rows alone. Currencies are this
 * file's own (QW*), rated or deliberately not, so no shared rate is moved
 * (#380, #183) — and removed at the end, because a currency shows up in every
 * picker while it exists.
 */

const STAMP = String(Date.now()).slice(-6);
const RATED = 'QWR';
const UNRATED = 'QWU';
const UNRATED_TILL = 'QWT';
const PAY = 'QWP';
const NO_TILL = 'QWN';
const OWN_CURRENCIES = [RATED, UNRATED, UNRATED_TILL, PAY, NO_TILL];
let actorId = '';
let costTypeId = '';
let cashCategory = '';
let nonCashCategory = '';
let batchId = '';
let clientId = '';
let staffPartnerId = '';
const madeWarehouses: string[] = [];
const madeTills: string[] = [];
const madeCosts: string[] = [];
const madeExpenses: string[] = [];
const madeClients: string[] = [];
const madePartners: string[] = [];
const ctx = () => ({ actorId });
const cents = (value: number) => Math.round(value * 100) / 100;

async function till(name: string, currency: string, over: Partial<typeof moneyAccounts.$inferInsert> = {}) {
  const [row] = await db
    .insert(moneyAccounts)
    .values({ name: `${name} ${STAMP}`, currency, ...over })
    .returning();
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

async function expense(amount: number, currency: string, expenseDate: string, over: Record<string, unknown> = {}) {
  const row = await addExpense(
    { categoryId: cashCategory, amount, currency, expenseDate, accountId: '', ...over },
    ctx(),
  );
  madeExpenses.push(row.id);
  return row.id;
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  costTypeId = (await db.select({ id: costTypes.id }).from(costTypes).limit(1))[0]!.id;
  cashCategory = (
    await db.insert(expenseCategories).values({ name: `Hisobot naqd ${STAMP}` }).returning()
  )[0]!.id;
  nonCashCategory = (
    await db.insert(expenseCategories).values({ name: `Hisobot naqdsiz ${STAMP}`, cash: false }).returning()
  )[0]!.id;
  // Inactive: a test currency must not appear in anybody's picker.
  for (const code of OWN_CURRENCIES) {
    await db.insert(currencies).values({ code, name: `Hisobot ${code}`, active: false }).onConflictDoNothing();
  }
  // One flat rate for the whole of history, so both ends of any period read
  // the same one and only the rows themselves can move the dollars.
  for (const [currency, rate] of [
    [RATED, '0.0001'],
    [PAY, '0.5'],
    [NO_TILL, '0.5'],
  ] as const) {
    await db
      .insert(fxRates)
      .values({ currency, rateToUsd: rate, effectiveDate: '1600-01-01', enteredBy: actorId })
      .onConflictDoNothing();
  }
  for (const [code, country] of [
    [`HQ${STAMP}`, 'CN'],
    [`HR${STAMP}`, 'UZ'],
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
    code: `HQ${STAMP}-001`,
    originWarehouseId: madeWarehouses[0]!,
    destWarehouseId: madeWarehouses[1]!,
    status: 'forming',
    createdBy: actorId,
  });
  clientId = (
    await db.insert(clients).values({ clientCode: `HR${STAMP}`, name: `Hisobot mijoz ${STAMP}` }).returning()
  )[0]!.id;
  const [staffType] = await db.select().from(partnerTypes).where(eq(partnerTypes.code, 'staff'));
  staffPartnerId = (
    await db
      .insert(partners)
      .values({ name: `Hisobot hodim ${STAMP}`, typeId: staffType!.id, createdBy: actorId })
      .returning()
  )[0]!.id;
});

afterAll(async () => {
  // Children before the rows they name; the currency LAST (#183).
  await db.delete(partnerTransactions).where(inArray(partnerTransactions.partnerId, [staffPartnerId, ...madePartners]));
  if (madeCosts.length) await db.delete(costEntries).where(inArray(costEntries.id, madeCosts));
  if (madeExpenses.length) await db.delete(expenses).where(inArray(expenses.id, madeExpenses));
  await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, [clientId, ...madeClients]));
  if (madeTills.length) {
    await db.delete(accountTransfers).where(inArray(accountTransfers.fromAccountId, madeTills));
    await db.delete(accountTransfers).where(inArray(accountTransfers.toAccountId, madeTills));
    await db.delete(moneyAccounts).where(inArray(moneyAccounts.id, madeTills));
  }
  await db.delete(partners).where(inArray(partners.id, [staffPartnerId, ...madePartners]));
  await db.delete(clients).where(inArray(clients.id, [clientId, ...madeClients]));
  await db.delete(batches).where(eq(batches.id, batchId));
  await db.delete(warehouses).where(inArray(warehouses.id, madeWarehouses));
  await db.delete(expenseCategories).where(inArray(expenseCategories.id, [cashCategory, nonCashCategory]));
  await db.delete(fxRates).where(inArray(fxRates.currency, OWN_CURRENCIES));
  await db.delete(currencies).where(inArray(currencies.code, OWN_CURRENCIES));
  await pgClient.end();
});

describe('the cash flow page reconciles the kassas (U13)', () => {
  const FROM = '1640-01-01';
  const TO = '1640-12-31';
  let k1 = '';
  let k2 = '';
  let k3 = '';
  let k4 = '';

  beforeAll(async () => {
    k1 = await till('Hisobot USD', 'USD', { openingBalance: '10000', openingDate: '1640-03-01' });
    k2 = await till('Hisobot QWR', RATED, { openingBalance: '1000000', openingDate: '1640-03-01' });
    k3 = await till('Hisobot eski', 'USD', { openingBalance: '4000', active: false });
    k4 = await till('Hisobot sanoqsiz', 'USD');

    const pay = (amount: number, txDate: string, accountId?: string) =>
      addTransaction({ clientId, type: 'payment', amount, currency: 'USD', txDate, accountId }, ctx());
    await pay(2000, '1640-03-10', k1);
    await pay(100, '1640-02-15', k1); // before K1's count: inside it
    await pay(50, '1640-03-12'); // reached no kassa (the pre-#994 shape)
    await expense(200, 'USD', '1640-03-15'); // a cash overhead with no kassa
    // Non-cash, from a kassa: the shape typed before the door refused it
    // (U06) — so it is written through the cash category and moved after.
    const legacy = await expense(100, 'USD', '1640-03-16', { accountId: k1 });
    await db.update(expenses).set({ categoryId: nonCashCategory }).where(eq(expenses.id, legacy));
    await expense(250_000, RATED, '1640-03-17', { accountId: k2 });
    await cost(1000, 'USD', '1640-03-18', { accountId: k1 });
    await cost(600, 'USD', '1640-03-19'); // the accountant's queue
    const history = await cost(350, 'USD', '1640-03-20');
    // Typed before kassas were asked for: history, never the queue (#1018).
    await db.update(costEntries).set({ createdAt: new Date('2000-01-01T00:00:00Z') }).where(eq(costEntries.id, history));
    // $1,000 buys 12,000,000 QWR worth $1,200 at the table: a $200 gain.
    await addTransfer(
      { fromAccountId: k1, toAccountId: k2, amountFrom: 1000, amountTo: 12_000_000, transferDate: '1640-03-21' },
      ctx(),
    );
    // Out of a box with no count into K1 BEFORE K1's count: one half counted.
    await addTransfer(
      { fromAccountId: k4, toAccountId: k1, amountFrom: 10, amountTo: 10, transferDate: '1640-02-20' },
      ctx(),
    );
  });

  it('every box adds up in its own money: opening + its count + in − out = closing', async () => {
    const rows = await accountBalancesBetween(FROM, TO);
    for (const row of rows) {
      expect(cents(row.opening + row.countedInPeriod + row.inflow - row.outflow), row.name).toBe(row.closing);
    }
    const mine = new Map(rows.map((row) => [row.id, row]));
    expect(mine.get(k1)).toMatchObject({ opening: 0, countedInPeriod: 10000, closing: 9900, beforeOpeningInPeriod: 2 });
    expect(mine.get(k2)).toMatchObject({ opening: 0, countedInPeriod: 1_000_000, closing: 12_750_000 });
    expect(mine.get(k3)).toMatchObject({ opening: 4000, closing: 4000, active: false });
    expect(mine.get(k4)).toMatchObject({ opening: 0, closing: -10, transfersOut: 10 });
  });

  it('the closing box of a period is the balance the kassa screen shows today, when nothing came after', async () => {
    const { accountBalances } = await import('@/modules/wms/accounting/service');
    const today = tashkentDay();
    const [between, now] = await Promise.all([accountBalancesBetween('1640-01-01', today), accountBalances()]);
    for (const id of [k1, k2, k3, k4]) {
      expect(between.find((row) => row.id === id)!.closing).toBe(now.find((row) => row.id === id)!.balance);
    }
  });

  it('opening cash + the cash flow + the named lines = closing cash, to the cent', async () => {
    const recon = await cashReconciliation(FROM, TO);
    expect(recon.unexplained).toBe(0);
    const line = (key: string) => recon.lines.find((entry) => entry.key === key)?.usd ?? 0;
    expect(recon.netFlowUsd).toBe(-25);
    expect(line('countedInPeriod')).toBe(10_100);
    expect(line('noKassaPayments')).toBe(-50);
    expect(line('queuedCosts')).toBe(600);
    expect(line('historyCosts')).toBe(350);
    expect(line('noKassaExpenses')).toBe(200);
    expect(line('beforeOpening')).toBe(-100);
    expect(line('tillOnly')).toBe(-100);
    expect(line('oneSidedTransfers')).toBe(-10);
    expect(line('fx')).toBe(200);
    expect(cents(recon.closingUsd - recon.openingUsd)).toBe(11_165);
    // The retired box still holding money is listed, marked (#428).
    expect(recon.kassas.find((kassa) => kassa.id === k3)).toMatchObject({ active: false, closing: 4000 });
  });

  it('names the overheads saved with no kassa and no payer — inside the outflow, in no drawer (U13, answer A)', async () => {
    const flow = await cashFlow(FROM, TO);
    expect(flow.cashOpexNoKassaCount).toBe(1);
    expect(flow.cashOpexNoKassaUsd).toBe(200);
    // Still spent: the outflow keeps it (cargo 1,950 + cash overheads 225).
    expect(flow.outflow).toBe(2175);
    // …and the month bucket the dashboard's chart reads says the same.
    expect((await cashFlowByMonth(FROM, TO)).get('1640-03')!.cashOpexNoKassaCount).toBe(1);
  });
});

describe('a cost with no rate is named in the cash flow, never a silent $0 (U24)', () => {
  const DAY = '1641-05-10';

  it('names the unrated costs the cash flow counts — not the partner-settled or voided ones', async () => {
    const usdTill = await till('Hisobot U24', 'USD');
    await cost(100, 'USD', DAY); // converted: must not be named
    await cost(7000, UNRATED, DAY, { accountId: usdTill, accountAmount: 50 });
    await cost(3000, UNRATED, DAY);
    // Rows the cash flow leaves out on purpose, written directly because no
    // door writes them any more: a partner-settled one and a voided one.
    for (const over of [{ partnerId: staffPartnerId }, { voidedAt: new Date(), voidedBy: actorId, voidReason: 'test' }]) {
      const [row] = await db
        .insert(costEntries)
        .values({
          scope: 'batch',
          batchId,
          costTypeId,
          amount: '999',
          currency: UNRATED,
          costDate: DAY,
          allocationBasis: 'weight',
          enteredBy: actorId,
          ...over,
        })
        .returning({ id: costEntries.id });
      madeCosts.push(row!.id);
    }

    const flow = await cashFlow(DAY, DAY);
    expect(flow.unconverted).toEqual({
      count: 2,
      tillPaid: 1,
      byCurrency: [{ currency: UNRATED, count: 2, amount: 10_000, tillPaid: 1 }],
    });
    // The row itself is untouched: $100, the unrated ones read as $0 there.
    expect(flow.rows.find((row) => row.label === 'cargoCosts')!.amountUsd).toBe(100);
    // …and the month bucket carries the same count as the report.
    expect((await cashFlowByMonth('1641-05-01', '1641-05-31')).get('1641-05')!.unconvertedCount).toBe(2);
  });
});

describe('the Balans counts kassa-less cargo costs as money gone (U02)', () => {
  const DAY = '1642-01-10';

  it('a cost with no kassa lowers the net the day it is typed, and placing it moves cash, not the net', async () => {
    const usdTill = await till('Hisobot U02', 'USD');
    const before = await companyBalance();
    const id = await cost(350, 'USD', DAY);
    const typed = await companyBalance();
    expect(cents(typed.netUsd - before.netUsd)).toBe(-350);
    expect(cents(typed.unplacedCostUsd - before.unplacedCostUsd)).toBe(350);
    expect(typed.unplacedCostCount - before.unplacedCostCount).toBe(1);

    await setCostAccount(id, usdTill, undefined, ctx());
    const placed = await companyBalance();
    expect(cents(placed.netUsd - typed.netUsd)).toBe(0);
    expect(cents(placed.cashUsd - typed.cashUsd)).toBe(-350);
  });

  it('«a colleague paid it» turns the missing kassa into a debt, the net unmoved', async () => {
    const id = await cost(80, 'USD', DAY);
    const typed = await companyBalance();
    await setCostStaffPayer(id, staffPartnerId, ctx());
    const owed = await companyBalance();
    expect(cents(owed.netUsd - typed.netUsd)).toBe(0);
    expect(cents(owed.payableUsd - typed.payableUsd)).toBe(80);
    expect(cents(owed.unplacedCostUsd - typed.unplacedCostUsd)).toBe(-80);
  });
});

describe('the Balans says which tills it could not put in dollars (U14)', () => {
  it('money moved into a till with no rate leaves the net and is NAMED — an empty one raises nothing', async () => {
    const source = await till('Hisobot U14 USD', 'USD', { openingBalance: '1000' });
    const target = await till('Hisobot U14 QWT', UNRATED_TILL);
    await till('Hisobot U14 QWT bo‘sh', UNRATED_TILL);
    const before = await companyBalance();
    expect(before.unratedTills.find((row) => row.currency === UNRATED_TILL)).toBeUndefined();

    await addTransfer(
      { fromAccountId: source, toAccountId: target, amountFrom: 1000, amountTo: 7100, transferDate: '1643-01-10' },
      ctx(),
    );
    const after = await companyBalance();
    expect(cents(after.netUsd - before.netUsd)).toBe(-1000);
    expect(after.unratedTills.find((row) => row.currency === UNRATED_TILL)).toEqual({
      currency: UNRATED_TILL,
      balance: 7100,
      count: 1,
    });
    // Totals first, the rows last: the AI's tool slices the JSON (#1015).
    const keys = Object.keys(after);
    expect(keys.indexOf('unratedTills')).toBeLessThan(keys.indexOf('cashRows'));
    expect(keys.indexOf('negativeTills')).toBeLessThan(keys.indexOf('cashRows'));
  });

  it('a till spent below zero is allowed, summed as it stands, and NAMED (U14, answer a)', async () => {
    const empty = await till('Hisobot U14 minus', 'USD');
    const before = await companyBalance();
    expect(before.negativeTills.some((row) => row.id === empty)).toBe(false);
    // Nothing refuses it: entries are typed out of order.
    await expense(700, 'USD', '1643-02-01', { accountId: empty });
    const after = await companyBalance();
    expect(cents(after.netUsd - before.netUsd)).toBe(-700);
    expect(after.negativeTills.find((row) => row.id === empty)).toMatchObject({ balance: -700, currency: 'USD', kind: 'cash' });
  });
});

describe('a kassa-less payment is on the Balans only while no count holds it (U09)', () => {
  // Payments are dated TODAY: the A2 bound reads «since the first kassa was
  // created», and every kassa in a fresh database was created today.
  const today = tashkentDay();
  const state = async () => {
    const [balance, counts, register] = await Promise.all([
      companyBalance(),
      moneyFlowCounts(today),
      paymentsRegister(today, today, undefined, { unplaced: true }),
    ]);
    return { balance, counts, ids: new Set(register.rows.map((row) => row.id)) };
  };
  const pay = async (currency: string) =>
    (await addTransaction({ clientId, type: 'payment', amount: 100, currency, txDate: today }, ctx())).id;

  it('dated before EVERY count of its currency: inside the counts, off the line — and placing it moves nothing', async () => {
    // The count holds that cash: 100 QWP counted tomorrow.
    const counted = await till('Hisobot U09 sanoq', PAY, { openingBalance: '100', openingDate: addDays(today, 1) });
    const before = await state();
    const id = await pay(PAY);
    const after = await state();
    expect(after.balance.unplacedCount).toBe(before.balance.unplacedCount);
    expect(after.counts.unassignedPayments).toBe(before.counts.unassignedPayments);
    expect(after.ids.has(id)).toBe(false);

    await placePayment(id, counted, ctx());
    const placed = await companyBalance();
    expect(cents(placed.netUsd - after.balance.netUsd)).toBe(0);
    await db.update(moneyAccounts).set({ active: false }).where(eq(moneyAccounts.id, counted));
  });

  it('while ONE till of its currency was counted before it, it stays on the line', async () => {
    await till('Hisobot U09 kech', PAY, { openingDate: addDays(today, 1) });
    const early = await till('Hisobot U09 erta', PAY, { openingDate: addDays(today, -1) });
    const before = await state();
    const id = await pay(PAY);
    const after = await state();
    expect(after.balance.unplacedCount).toBe(before.balance.unplacedCount + 1);
    expect(after.counts.unassignedPayments).toBe(before.counts.unassignedPayments + 1);
    expect(after.ids.has(id)).toBe(true);
    await db
      .update(moneyAccounts)
      .set({ active: false })
      .where(and(eq(moneyAccounts.currency, PAY), inArray(moneyAccounts.id, madeTills)));
    expect(early).toBeTruthy();
  });

  it('a till with no count at all takes every row, so the payment stays — and placing it moves cash, not the net', async () => {
    const open = await till('Hisobot U09 sanoqsiz', PAY);
    const before = await state();
    const id = await pay(PAY);
    const after = await state();
    expect(after.ids.has(id)).toBe(true);
    expect(cents(after.balance.unplacedUsd - before.balance.unplacedUsd)).toBe(50);
    await placePayment(id, open, ctx());
    const placed = await companyBalance();
    expect(cents(placed.netUsd - after.balance.netUsd)).toBe(0);
    expect(cents(placed.cashUsd - after.balance.cashUsd)).toBe(50);
  });

  it('a currency with no till at all stays on the line, or it would drop out of the net unseen', async () => {
    const before = await state();
    const id = await pay(NO_TILL);
    const after = await state();
    expect(after.ids.has(id)).toBe(true);
    expect(after.balance.unplacedCount).toBe(before.balance.unplacedCount + 1);
  });
});

describe('«this month\'s payments» is one figure, and its parts are the other screens\' (U26)', () => {
  const today = tashkentDay();
  const monthStart = tashkentMonthStart();

  it('the homes print what the clients closed, net — each part the cash flow\'s or the register\'s own number', async () => {
    const payer = (
      await db.insert(clients).values({ clientCode: `HS${STAMP}`, name: `Hisobot U26 ${STAMP}` }).returning()
    )[0]!.id;
    madeClients.push(payer);
    const [transport] = await db.select().from(partnerTypes).where(eq(partnerTypes.code, 'transport'));
    const firm = (
      await db
        .insert(partners)
        .values({ name: `Hisobot firma ${STAMP}`, typeId: transport!.id, createdBy: actorId })
        .returning()
    )[0]!.id;
    madePartners.push(firm);
    const kassa = await till('Hisobot U26', 'USD');

    const before = await moneySnapshot();
    // 4,800 billed against 5,080 closed leaves a $280 advance for the refund
    // to come out of — a refund past the advance is refused (U04).
    await addTransaction({ clientId: payer, type: 'charge', amount: 4800, currency: 'USD', txDate: today }, ctx());
    await addTransaction(
      { clientId: payer, type: 'payment', amount: 4800, currency: 'USD', txDate: today, accountId: kassa },
      ctx(),
    );
    await recordSettlement(
      {
        txId: uuidv4(),
        clientId: payer,
        partnerId: firm,
        clientAmount: 280,
        clientCurrency: 'USD',
        partnerAmount: 280,
        partnerCurrency: 'USD',
        txDate: today,
        note: 'hisobot testi',
      },
      ctx(),
    );
    await addTransaction(
      { clientId: payer, type: 'refund', amount: 200, currency: 'USD', txDate: today, accountId: kassa },
      ctx(),
    );
    const after = await moneySnapshot();
    expect(cents(after.paidParts.toTill - before.paidParts.toTill)).toBe(4800);
    expect(cents(after.paidParts.viaPartner - before.paidParts.viaPartner)).toBe(280);
    expect(cents(after.paidParts.refunded - before.paidParts.refunded)).toBe(200);
    expect(cents(after.paidMonth - before.paidMonth)).toBe(4880);

    // The same month on the screens the rows link to — one set of rows, so
    // the figures are equal, not merely close.
    const [flow, register] = await Promise.all([cashFlow(monthStart, today), paymentsRegister(monthStart, today)]);
    const row = (label: string) => flow.rows.find((entry) => entry.label === label)?.amountUsd ?? 0;
    expect(after.paidParts.toTill).toBe(row('clientPayments'));
    expect(after.paidParts.refunded).toBe(row('clientRefunds'));
    expect(cents(after.paidParts.toTill + after.paidParts.viaPartner)).toBe(register.totalUsd);
    expect(after.paidMonth).toBe(cents(after.paidParts.toTill + after.paidParts.viaPartner - after.paidParts.refunded));
  });

  it('a refund handed back today is new debt from today, not debt older than 60 days', async () => {
    const payer = (
      await db.insert(clients).values({ clientCode: `HT${STAMP}`, name: `Hisobot U26 eski ${STAMP}` }).returning()
    )[0]!.id;
    madeClients.push(payer);
    const kassa = await till('Hisobot U26 eski', 'USD');
    // A refund may pass the advance only by the FX residue (U04, ≤ $5): a $3
    // advance, $7 handed back, $4 owed — from today, not from 70 days ago.
    await addTransaction({ clientId: payer, type: 'charge', amount: 1000, currency: 'USD', txDate: addDays(today, -70) }, ctx());
    await addTransaction(
      { clientId: payer, type: 'payment', amount: 1003, currency: 'USD', txDate: addDays(today, -65), accountId: kassa },
      ctx(),
    );
    const before = await moneySnapshot();
    await addTransaction(
      { clientId: payer, type: 'refund', amount: 7, currency: 'USD', txDate: today, accountId: kassa },
      ctx(),
    );
    const after = await moneySnapshot();
    expect(cents(after.receivable - before.receivable)).toBe(4);
    expect(cents(after.receivableOld - before.receivableOld)).toBe(0);
  });
});

describe('the cash flow sums one predicate with the reconciliation', () => {
  it('a 1640 report reads this file alone', async () => {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(clientTransactions)
      .where(and(sql`${clientTransactions.txDate} BETWEEN '1640-01-01' AND '1640-12-31'`));
    expect(rows[0]!.n).toBe(3);
  });
});
