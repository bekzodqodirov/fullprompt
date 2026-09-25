import 'dotenv/config';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  clientTransactions,
  clients,
  costAllocations,
  costEntries,
  costTypes,
  currencies,
  fxRates,
  moneyAccounts,
  partnerTransactions,
  partnerTypes,
  partners,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import {
  addCostEntry,
  recomputeAll,
  unplacedCostSince,
  upsertFxRate,
  voidCostEntry,
} from '@/modules/wms/costing/service';
import {
  ConfirmNeeded,
  planMoves,
  repriceStale,
  saveFxRate,
  staleDebtSummary,
  stalePayments,
  type RepricePlan,
} from '@/modules/wms/costing/fx-reprice';
import { addTransaction, clientBalanceUsd } from '@/modules/wms/finance/service';
import { addPartnerTx, partnerBalanceUsd } from '@/modules/wms/partners/service';
import { accountBalances } from '@/modules/wms/accounting/service';
import { cashFlow, profitAndLoss } from '@/modules/wms/accounting/reports';

/**
 * Q18 (the owner's answer, 2026-09-25): a rate typed late or corrected
 * re-prices the DEBTS it governs and the tannarx of a kassa-paid cost — never
 * a payment — and the save SHOWS what will move before it moves (the preview
 * is the apply, rolled back). The design's E1-E13.
 *
 * The year is 1613, dated by nothing else; the currencies are this file's
 * own (ZS*), each test using its own so a saved rate re-prices nothing of
 * another's; removed at the end (#380, #183). A rate written through the
 * low-level `upsertFxRate` re-prices nothing — which is how «a rate that
 * arrived before the re-price existed» is made.
 */

const STAMP = String(Date.now()).slice(-6);
const OWN = ['ZSA', 'ZSB', 'ZSC', 'ZSD', 'ZSE', 'ZSF', 'ZSG', 'ZSH'];
let actorId = '';
let costTypeId = '';
let batchId = '';
let since = '';
let n = 0;
const madeClients: string[] = [];
const madePartners: string[] = [];
const madeTills: string[] = [];
const madeCosts: string[] = [];
const madeWarehouses: string[] = [];
const ctx = () => ({ actorId });
const classify = { mayClassify: true };
const cents = (value: number) => Math.round(value * 100) / 100;

async function rate(currency: string, effectiveDate: string, rateToUsd: number) {
  await upsertFxRate({ currency, effectiveDate, rateToUsd }, ctx());
}

async function client(tag: string) {
  n += 1;
  const [row] = await db
    .insert(clients)
    .values({ clientCode: `S${n}${STAMP}`.slice(0, 10), name: `FX kurs ${tag} ${STAMP}` })
    .returning();
  madeClients.push(row!.id);
  return row!.id;
}

async function partner(tag: string) {
  const [type] = await db.select().from(partnerTypes).where(sql`${partnerTypes.code} <> 'staff'`).limit(1);
  const [row] = await db
    .insert(partners)
    .values({ name: `FX kurs firma ${tag} ${STAMP}`, typeId: type!.id, createdBy: actorId })
    .returning();
  madePartners.push(row!.id);
  return row!.id;
}

async function till(currency: string) {
  n += 1;
  const [row] = await db.insert(moneyAccounts).values({ name: `FX kurs ${currency} ${n} ${STAMP}`, currency }).returning();
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

async function costRow(id: string) {
  return (await db.select().from(costEntries).where(eq(costEntries.id, id)))[0]!;
}

async function chargeOf(costId: string) {
  return (
    await db
      .select()
      .from(partnerTransactions)
      .where(and(eq(partnerTransactions.costEntryId, costId), isNull(partnerTransactions.voidedAt)))
  )[0];
}

/** The first press: nothing written, the plan handed back. */
async function preview(run: (hash: string | null) => Promise<RepricePlan>): Promise<RepricePlan> {
  try {
    await run(null);
  } catch (err) {
    if (err instanceof ConfirmNeeded) return err.plan;
    throw err;
  }
  throw new Error('the save moved something without asking');
}

const net = async (from: string, to: string) => cents((await profitAndLoss(from, to)).netProfit.total);

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  costTypeId = (await db.select({ id: costTypes.id }).from(costTypes).limit(1))[0]!.id;
  since = await unplacedCostSince();
  for (const code of OWN) {
    await db.insert(currencies).values({ code, name: `FX kurs ${code}`, active: false }).onConflictDoNothing();
  }
  for (const [code, country] of [
    [`SQ${STAMP}`, 'CN'],
    [`SR${STAMP}`, 'UZ'],
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
    code: `SQ${STAMP}-001`,
    originWarehouseId: madeWarehouses[0]!,
    destWarehouseId: madeWarehouses[1]!,
    status: 'forming',
    createdBy: actorId,
  });
});

afterAll(async () => {
  if (madePartners.length) await db.delete(partnerTransactions).where(inArray(partnerTransactions.partnerId, madePartners));
  if (madeClients.length) await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, madeClients));
  if (madeCosts.length) {
    await db.delete(costAllocations).where(inArray(costAllocations.costEntryId, madeCosts));
    await db.delete(costEntries).where(inArray(costEntries.id, madeCosts));
  }
  if (madePartners.length) await db.delete(partners).where(inArray(partners.id, madePartners));
  if (madeClients.length) await db.delete(clients).where(inArray(clients.id, madeClients));
  if (madeTills.length) await db.delete(moneyAccounts).where(inArray(moneyAccounts.id, madeTills));
  await db.delete(batches).where(eq(batches.id, batchId));
  await db.delete(warehouses).where(inArray(warehouses.id, madeWarehouses));
  await db.delete(fxRates).where(inArray(fxRates.currency, OWN));
  await db.delete(currencies).where(inArray(currencies.code, OWN));
  await pgClient.end();
});

describe('E1, E2, E6, E7 — a firm’s truck on credit follows the corrected rate, with its debt', () => {
  it('previews, confirms, stays inside its window, and is idempotent', async () => {
    const C = 'ZSA';
    await rate(C, '1613-07-01', 0.14);
    await rate(C, '1613-09-25', 0.12);
    const firm = await partner('E1');
    const paidFirm = await partner('E1 paid');
    const truck = await cost(10_000, C, '1613-09-20', { partnerId: paidFirm }); // $1,400
    const before = await cost(10_000, C, '1613-09-19', { partnerId: firm }); // $1,400, outside
    const after = await cost(10_000, C, '1613-09-25', { partnerId: firm }); // $1,200 at its own rate
    // E2: a stale row BEYOND the window (typed before the 09-25 rate existed) is not this save's.
    const beyond = await cost(10_000, C, '1613-09-26', { partnerId: firm });
    await db.update(costEntries).set({ amountUsd: '1400.00', fxRateUsed: '0.14' }).where(eq(costEntries.id, beyond));
    // E7: a voided debt cost in the window keeps its dollars.
    const voided = await cost(5_000, C, '1613-09-21', { partnerId: firm });
    await voidCostEntry(voided, 'xato', ctx(), { mayMoveTill: true });
    expect((await costRow(truck)).amountUsd).toBe('1400.00');
    expect((await chargeOf(truck))!.amountUsd).toBe('1400.00');

    const input = { currency: C, rateToUsd: 0.13, effectiveDate: '1613-09-20' };
    const plan = await preview((planHash) => saveFxRate(input, ctx(), { planHash, since }));
    expect(plan.costs.map((c) => c.id)).toEqual([truck]);
    expect(plan.costCharges).toHaveLength(1);
    expect(cents(plan.costs[0]!.newUsd - plan.costs[0]!.oldUsd)).toBe(-100);
    expect(plan.scope).toMatchObject({ kind: 'rate', window: { from: '1613-09-20', to: '1613-09-25' } });
    // Rolled back: no rate row, the cost unchanged.
    expect(
      await db.select().from(fxRates).where(and(eq(fxRates.currency, C), eq(fxRates.effectiveDate, '1613-09-20'))),
    ).toHaveLength(0);
    expect((await costRow(truck)).amountUsd).toBe('1400.00');

    const done = await saveFxRate(input, ctx(), { planHash: plan.hash, since });
    expect(done.hash).toBe(plan.hash);
    expect(await costRow(truck)).toMatchObject({ amountUsd: '1300.00', fxRateUsed: '0.130000000000' });
    expect((await chargeOf(truck))!.amountUsd).toBe('1300.00');
    expect((await costRow(before)).amountUsd).toBe('1400.00');
    expect((await costRow(after)).amountUsd).toBe('1200.00');
    expect((await costRow(beyond)).amountUsd).toBe('1400.00');
    expect((await costRow(voided)).amountUsd).toBe('700.00');

    // E6: the same save again finds nothing to move and commits with no question.
    const again = await saveFxRate(input, ctx(), { planHash: null, since });
    expect(planMoves(again)).toBe(false);

    // A second identical truck typed now is born at the new rate, and the firm
    // paid ¥20,000 for ¥20,000 of trucks reads 0 (U40 A) — not «$100 qarz».
    const second = await cost(10_000, C, '1613-09-20', { partnerId: paidFirm });
    expect((await costRow(second)).amountUsd).toBe('1300.00');
    const cnyTill = await till(C);
    await addPartnerTx(
      { partnerId: paidFirm, type: 'payment', amount: 20_000, currency: C, txDate: '1613-09-22', accountId: cnyTill },
      ctx(),
      classify,
    );
    expect(await partnerBalanceUsd(paidFirm)).toBe(0);
  });
});

describe('E3 — payments frozen, tannarx follows (money-2, owner-1)', () => {
  it('a kassa-paid cost moves its tannarx only; no month’s net, no cash flow, no kassa moves', async () => {
    const C = 'ZSC';
    await rate(C, '1613-07-01', 0.14);
    await rate(C, '1613-10-01', 0.135);
    const usdTill = await till('USD');
    const kassaCost = await cost(20_000, C, '1613-09-20', { accountId: usdTill, accountAmount: 2850 });
    expect(await costRow(kassaCost)).toMatchObject({ amountUsd: '2800.00', accountAmountUsd: '2850.00' });
    // A client's so'm-like job: charged in September, paid in October at another rate.
    const buyer = await client('E3');
    await addTransaction({ clientId: buyer, type: 'charge', amount: 5_000, currency: C, txDate: '1613-09-20' }, ctx()); // $700
    await addTransaction({ clientId: buyer, type: 'payment', amount: 5_000, currency: C, txDate: '1613-10-05' }, ctx()); // $675
    expect(await clientBalanceUsd(buyer)).toBe(0);

    const netBefore = await net('1613-09-01', '1613-10-31');
    const flowBefore = await cashFlow('1613-09-01', '1613-09-30');
    const tillBefore = (await accountBalances()).find((row) => row.id === usdTill)!.balance;

    const input = { currency: C, rateToUsd: 0.13, effectiveDate: '1613-09-20' };
    const plan = await preview((planHash) => saveFxRate(input, ctx(), { planHash, since }));
    expect(plan.kassaCosts.map((c) => c.id)).toEqual([kassaCost]);
    expect(plan.clientCharges).toHaveLength(1);
    expect(plan.fx.map((f) => f.action).sort()).toEqual(['create', 'void']);
    await saveFxRate(input, ctx(), { planHash: plan.hash, since });

    expect(await costRow(kassaCost)).toMatchObject({ amountUsd: '2600.00', accountAmountUsd: '2850.00' });
    expect(await clientBalanceUsd(buyer)).toBe(0);
    expect(await net('1613-09-01', '1613-10-31')).toBe(netBefore);
    const flowAfter = await cashFlow('1613-09-01', '1613-09-30');
    expect(cents(flowAfter.net)).toBe(cents(flowBefore.net));
    expect(cents(flowAfter.outflow)).toBe(cents(flowBefore.outflow));
    expect((await accountBalances()).find((row) => row.id === usdTill)!.balance).toBe(tillBefore);
  });
});

describe('E4, E5 — a queue cost, a slip corrected, and a plan that changed under the press', () => {
  it('E4: 1/11,500 corrected to 1/12,500 brings a queue cost from $1,086.96 back to $1,000', async () => {
    const C = 'ZSB';
    await rate(C, '1613-09-10', 1 / 11_500);
    const queued = await cost(12_500_000, C, '1613-09-12');
    expect((await costRow(queued)).amountUsd).toBe('1086.96');
    const input = { currency: C, rateToUsd: 0.00008, effectiveDate: '1613-09-10' };
    const plan = await preview((planHash) => saveFxRate(input, ctx(), { planHash, since }));
    expect(plan.costs.map((c) => [c.id, c.ownerId, c.newUsd])).toEqual([[queued, null, 1000]]);
    await saveFxRate(input, ctx(), { planHash: plan.hash, since });
    expect((await costRow(queued)).amountUsd).toBe('1000.00');
  });

  it('E5: a debt typed between the preview and the press is shown again, nothing applied', async () => {
    const C = 'ZSD';
    await rate(C, '1613-01-01', 0.00008);
    const buyer = await client('E5');
    await addTransaction({ clientId: buyer, type: 'charge', amount: 1_000_000, currency: C, txDate: '1613-09-12' }, ctx());
    await rate(C, '1613-09-10', 0.000076);
    // …but that second rate was typed through the low-level writer, so the charge is stale:
    const input = { currency: C, rateToUsd: 0.000075, effectiveDate: '1613-09-10' };
    const first = await preview((planHash) => saveFxRate(input, ctx(), { planHash, since }));
    expect(first.clientCharges).toHaveLength(1);
    await db.insert(clientTransactions).values({
      clientId: buyer,
      type: 'charge',
      amount: '500000',
      currency: C,
      rateToUsd: '0.00008',
      amountUsd: '40.00',
      txDate: '1613-09-15',
      createdBy: actorId,
    });
    let second: RepricePlan | null = null;
    try {
      await saveFxRate(input, ctx(), { planHash: first.hash, since });
    } catch (err) {
      if (!(err instanceof ConfirmNeeded)) throw err;
      second = err.plan;
    }
    expect(second, 'the stale hash was applied').not.toBeNull();
    expect(second!.clientCharges).toHaveLength(2);
    // Nothing applied: both charges still carry their old dollars.
    const charges = await db
      .select({ usd: clientTransactions.amountUsd })
      .from(clientTransactions)
      .where(eq(clientTransactions.clientId, buyer));
    expect(charges.map((row) => row.usd).sort()).toEqual(['40.00', '80.00']);
  });
});

describe('E8 — a new EARLIEST rate governs every date before it', () => {
  it('re-prices a debt dated before the first rate (from: null)', async () => {
    const C = 'ZSE';
    await rate(C, '1613-06-01', 0.14);
    const firm = await partner('E8');
    const early = await cost(10_000, C, '1613-03-01', { partnerId: firm }); // fallback 0.14
    expect((await costRow(early)).amountUsd).toBe('1400.00');
    const input = { currency: C, rateToUsd: 0.13, effectiveDate: '1613-01-01' };
    const plan = await preview((planHash) => saveFxRate(input, ctx(), { planHash, since }));
    expect(plan.scope).toMatchObject({ window: { from: null, to: '1613-06-01' } });
    await saveFxRate(input, ctx(), { planHash: plan.hash, since });
    expect((await costRow(early)).amountUsd).toBe('1300.00');
  });
});

describe('E9, E10 — the stale review, and the sweeps that never re-price', () => {
  it('lists a stale price by month, re-prices it on the confirm, and leaves a kassa’s side alone', async () => {
    const C = 'ZSF';
    await rate(C, '1613-01-01', 0.14);
    const buyer = await client('E9');
    await addTransaction({ clientId: buyer, type: 'charge', amount: 1000, currency: C, txDate: '1613-05-10' }, ctx()); // $140
    const kassa = await till(C);
    const kassaCost = await cost(1000, C, '1613-05-10', { accountId: kassa }); // same-currency kassa: rate 0.14 both sides
    // A rate that reached the table before the re-price existed.
    await rate(C, '1613-05-01', 0.12);
    // E10: the sweeps convert what waited and never move a converted row.
    await recomputeAll({ currency: C });
    expect((await costRow(kassaCost)).amountUsd).toBe('140.00');

    const stale = (await staleDebtSummary(since)).filter((row) => row.currency === C);
    expect(stale).toEqual([{ currency: C, month: '1613-05', count: 2, usd: 280 }]);
    const payments = (await stalePayments(C)).map((row) => [row.id, row.kind]);
    expect(payments).toContainEqual([kassaCost, 'cost_kassa']);

    const plan = await preview((planHash) => repriceStale(C, '1613-05', ctx(), { planHash, since }));
    expect(plan.clientCharges).toHaveLength(1);
    expect(plan.kassaCosts.map((c) => c.id)).toEqual([kassaCost]);
    expect(plan.frozenPayments).toBeGreaterThanOrEqual(1);
    await repriceStale(C, '1613-05', ctx(), { planHash: plan.hash, since });
    expect(await clientBalanceUsd(buyer)).toBe(120);
    expect(await costRow(kassaCost)).toMatchObject({ amountUsd: '120.00', accountAmountUsd: '140.00' });
    expect((await staleDebtSummary(since)).filter((row) => row.currency === C)).toEqual([]);
    // The kassa side is still off its day's rate — listed, never re-priced.
    expect((await stalePayments(C)).map((row) => row.id)).toContain(kassaCost);
  });
});

describe('E11, E12 — settled history stays settled; an open debt names its account', () => {
  it('E11: a firm’s pre-deploy closed pair is skipped; a client’s is re-priced and closed again', async () => {
    const C = 'ZSG';
    await rate(C, '1613-01-01', 0.14);
    const firm = await partner('E11');
    const cnyTill = await till(C);
    // History: a charge and its payment at one (stale) rate, typed long ago.
    for (const [type, extra] of [
      ['charge', {}],
      ['payment', { accountId: cnyTill }],
    ] as const) {
      await db.insert(partnerTransactions).values({
        partnerId: firm,
        type,
        amount: '10000',
        currency: C,
        rateToUsd: '0.14',
        amountUsd: '1400.00',
        txDate: '1613-04-10',
        createdBy: actorId,
        createdAt: new Date('2000-01-01T00:00:00Z'),
        ...extra,
      });
    }
    const buyer = await client('E11');
    for (const type of ['charge', 'payment'] as const) {
      await db.insert(clientTransactions).values({
        clientId: buyer,
        type,
        amount: '10000',
        currency: C,
        rateToUsd: '0.14',
        amountUsd: '1400.00',
        txDate: '1613-04-10',
        createdBy: actorId,
        createdAt: new Date('2000-01-01T00:00:00Z'),
      });
    }
    await rate(C, '1613-04-01', 0.13);
    const plan = await preview((planHash) => repriceStale(C, '1613-04', ctx(), { planHash, since }));
    expect(plan.settledOld).toBe(1);
    expect(plan.manualCharges).toHaveLength(0);
    expect(plan.clientCharges).toHaveLength(1);
    expect(plan.fx.map((f) => [f.ledger, f.action, f.amountUsd])).toEqual([['client', 'create', 100]]);
    expect(plan.balances).toEqual([]);
    await repriceStale(C, '1613-04', ctx(), { planHash: plan.hash, since });
    expect(await partnerBalanceUsd(firm)).toBe(0);
    expect(await clientBalanceUsd(buyer)).toBe(0);
  });

  it('E12: an OPEN so’m charge re-priced names its account and both figures', async () => {
    const C = 'ZSH';
    await rate(C, '1613-01-01', 0.00008);
    const buyer = await client('E12');
    await addTransaction({ clientId: buyer, type: 'charge', amount: 12_500_000, currency: C, txDate: '1613-08-10' }, ctx());
    await rate(C, '1613-08-01', 0.000078125);
    const plan = await preview((planHash) => repriceStale(C, '1613-08', ctx(), { planHash, since }));
    const [code] = await db.select({ code: clients.clientCode, name: clients.name }).from(clients).where(eq(clients.id, buyer));
    expect(plan.balances).toEqual([
      { ledger: 'client', ownerId: buyer, label: `${code!.code} — ${code!.name}`, before: 1000, after: 976.56 },
    ]);
    expect(plan.months['1613-08']).toMatchObject({ revenue: -23.44, net: -23.44 });
  });
});
