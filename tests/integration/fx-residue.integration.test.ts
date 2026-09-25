import 'dotenv/config';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  batches,
  clientTransactions,
  clients,
  costAllocations,
  costEntries,
  costTypes,
  currencies,
  dealStages,
  deals,
  fxRates,
  moneyAccounts,
  partnerTransactions,
  partnerTypes,
  partners,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import {
  addTransaction,
  balancesForClients,
  clientBalances,
  clientBalanceUsd,
  deferredBalanceUsd,
  voidTransaction,
} from '@/modules/wms/finance/service';
import {
  addPartnerTx,
  partnerBalanceUsd,
  setAdjustKind,
  voidPartnerTx,
} from '@/modules/wms/partners/service';
import { addCostEntry } from '@/modules/wms/costing/service';
import { arAging, pnlGaps, profitAndLoss } from '@/modules/wms/accounting/reports';
import { fxCyclesFor, ownersSql, reconcileFxResidueTx } from '@/modules/wms/finance/fx-residue';
import { closeAllLegacyFx, closeLegacyFxResidue, legacyFxResidues } from '@/modules/wms/finance/fx-legacy';
import { closeCrossCurrencyResidue, crossCloseOffer, voidFxClose } from '@/modules/wms/finance/fx-close';
import { applyFxHistory, fxHistoryPlan } from '@/modules/wms/finance/fx-history';
import { blockingDebtUsd } from '@/modules/wms/issue/approvals';
import { clientFeed } from '@/modules/wms/crm/feed';
import { openStaffPartner, staffAccountView } from '@/modules/wms/partners/staff-account';

/**
 * Q14 (the owner's answer A, 2026-09-25): an account back at zero in its OWN
 * currency closes its dollar residue with a «kurs farqi» row the system
 * writes in the same commit — plus Q12's split of the partner correction,
 * the handover deferral that must not count a closed cycle, the refund cap's
 * native rule, the history («Kurs qoldiqlari», the deploy script) and the
 * accountant's two-currency close (open question 1, answer b). Every
 * scenario is the design's D0-D19 unless it says otherwise.
 *
 * The year is 1612, dated by nothing else. The currencies are this file's own
 * (ZR*), with rates that MOVE on the 1st of each month so a payment a month
 * after its charge carries a residue; removed at the end (#380, #183).
 * «History» (rows typed before the deploy) is made by inserting rows
 * directly with an old `created_at` — never by moving the global
 * `fx_residue_since`, which every other file's reconciler reads (#653). The
 * kill-switch is flipped INSIDE a rolled-back transaction for the same
 * reason.
 */

const STAMP = String(Date.now()).slice(-6);
const SOM = 'ZRA'; // 1/12,500 → 1/12,800 → 1/12,200
const CNY = 'ZRB'; // 0.14 → 0.13
const HALF = 'ZRC'; // flat 0.00007693 — two halves round up
const OWN = [SOM, CNY, HALF];
const JAN = '1612-01-10';
const FEB = '1612-02-10';
const MAR = '1612-03-10';
const LONG_AGO = '2000-01-01T00:00:00Z';
let actorId = '';
let stageId = '';
let costTypeId = '';
let batchId = '';
let n = 0;
const madeClients: string[] = [];
const madePartners: string[] = [];
const madeTills: string[] = [];
const madeDeals: string[] = [];
const madeUsers: string[] = [];
const madeCosts: string[] = [];
const madeWarehouses: string[] = [];
const ctx = () => ({ actorId });
const classify = { mayClassify: true };
const cents = (value: number) => Math.round(value * 100) / 100;

async function client(tag: string) {
  n += 1;
  const [row] = await db
    .insert(clients)
    .values({ clientCode: `R${n}${STAMP}`.slice(0, 10), name: `FX qoldiq ${tag} ${STAMP}` })
    .returning();
  madeClients.push(row!.id);
  return row!.id;
}

async function partner(tag: string) {
  const [type] = await db.select().from(partnerTypes).where(sql`${partnerTypes.code} <> 'staff'`).limit(1);
  const [row] = await db
    .insert(partners)
    .values({ name: `FX firma ${tag} ${STAMP}`, typeId: type!.id, createdBy: actorId })
    .returning();
  madePartners.push(row!.id);
  return row!.id;
}

async function till(currency: string) {
  n += 1;
  const [row] = await db.insert(moneyAccounts).values({ name: `FX qoldiq ${currency} ${n} ${STAMP}`, currency }).returning();
  madeTills.push(row!.id);
  return row!.id;
}

async function pay(clientId: string, type: 'charge' | 'payment', amount: number, currency: string, txDate: string, over: Record<string, unknown> = {}) {
  return addTransaction({ clientId, type, amount, currency, txDate, ...over }, ctx());
}

async function fxRows(ledger: 'client' | 'partner', ownerId: string, live = true) {
  if (ledger === 'client') {
    return db
      .select()
      .from(clientTransactions)
      .where(
        and(
          eq(clientTransactions.clientId, ownerId),
          eq(clientTransactions.type, 'fx_diff'),
          live ? isNull(clientTransactions.voidedAt) : sql`true`,
        ),
      );
  }
  return db
    .select()
    .from(partnerTransactions)
    .where(
      and(
        eq(partnerTransactions.partnerId, ownerId),
        eq(partnerTransactions.type, 'fx_diff'),
        live ? isNull(partnerTransactions.voidedAt) : sql`true`,
      ),
    );
}

const fxOf = async (key: string, from: string, to: string) =>
  cents((await profitAndLoss(from, to)).fx.find((line) => line.key === key)?.total ?? 0);

/** A row as the pre-0103 ledger wrote it: straight in, no reconciler, typed long ago. */
async function historyPartnerRow(
  partnerId: string,
  row: { type: 'receipt' | 'payment' | 'adjust'; amount: number; currency: string; rate: number; txDate: string; accountId?: string },
) {
  const id = uuidv4();
  await db.insert(partnerTransactions).values({
    id,
    partnerId,
    type: row.type,
    amount: String(row.amount),
    currency: row.currency,
    rateToUsd: String(row.rate),
    amountUsd: cents(row.amount * row.rate).toFixed(2),
    txDate: row.txDate,
    accountId: row.accountId ?? null,
    createdBy: actorId,
    createdAt: new Date(LONG_AGO),
  });
  return id;
}

async function historyClientRow(
  clientId: string,
  row: { type: 'charge' | 'payment'; amount: number; currency: string; rate: number; txDate: string },
) {
  const id = uuidv4();
  await db.insert(clientTransactions).values({
    id,
    clientId,
    type: row.type,
    amount: String(row.amount),
    currency: row.currency,
    rateToUsd: String(row.rate),
    amountUsd: cents(row.amount * row.rate).toFixed(2),
    txDate: row.txDate,
    createdBy: actorId,
    createdAt: new Date(LONG_AGO),
  });
  return id;
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  stageId = (await db.select({ id: dealStages.id }).from(dealStages).where(eq(dealStages.kind, 'open')).limit(1))[0]!.id;
  costTypeId = (await db.select({ id: costTypes.id }).from(costTypes).limit(1))[0]!.id;
  for (const code of OWN) {
    await db.insert(currencies).values({ code, name: `FX qoldiq ${code}`, active: false }).onConflictDoNothing();
  }
  for (const [currency, effectiveDate, rateToUsd] of [
    [SOM, '1612-01-01', '0.00008'],
    [SOM, '1612-02-01', '0.000078125'],
    [SOM, '1612-03-01', '0.000081967213'],
    [CNY, '1612-01-01', '0.14'],
    [CNY, '1612-02-01', '0.13'],
    [HALF, '1612-01-01', '0.00007693'],
  ] as const) {
    await db.insert(fxRates).values({ currency, rateToUsd, effectiveDate, enteredBy: actorId }).onConflictDoNothing();
  }
  for (const [code, country] of [
    [`RQ${STAMP}`, 'CN'],
    [`RR${STAMP}`, 'UZ'],
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
    code: `RQ${STAMP}-001`,
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
  if (madeDeals.length) await db.delete(deals).where(inArray(deals.id, madeDeals));
  if (madePartners.length) await db.delete(partners).where(inArray(partners.id, madePartners));
  if (madeClients.length) await db.delete(clients).where(inArray(clients.id, madeClients));
  if (madeTills.length) await db.delete(moneyAccounts).where(inArray(moneyAccounts.id, madeTills));
  await db.delete(batches).where(eq(batches.id, batchId));
  await db.delete(warehouses).where(inArray(warehouses.id, madeWarehouses));
  // An audited user cannot be deleted (audit_log FK): deactivated instead.
  if (madeUsers.length) await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
  await db.delete(fxRates).where(inArray(fxRates.currency, OWN));
  await db.delete(currencies).where(inArray(currencies.code, OWN));
  await pgClient.end();
});

describe('D0 — the walk finds where a currency returns to zero', () => {
  it('closed and open cycles, an advance first, ties by created_at', async () => {
    const id = await client('D0');
    // An advance first: the anchor is the CHARGE that brings it back to zero.
    await pay(id, 'payment', 1_000_000, SOM, JAN);
    const charge = await pay(id, 'charge', 1_000_000, SOM, FEB);
    // A second cycle closes, a third stays open.
    await pay(id, 'charge', 2_000_000, SOM, FEB);
    await pay(id, 'payment', 2_000_000, SOM, MAR);
    await pay(id, 'charge', 500_000, SOM, MAR);
    const cycles = await fxCyclesFor(db, 'client', ownersSql('client', [id]), null);
    expect(cycles.map((c) => c.closed)).toEqual([true, true, false]);
    expect(cycles[0]!.anchorId).toBe(charge.id);
    // Jan payment −80.00, Feb charge +78.13 → the account still reads −$1.87.
    expect(cycles[0]!.residueCents).toBe(-187);
    // Feb charge 2M = $156.25, Mar payment 2M = $163.93 → −$7.68.
    expect(cycles[1]!.residueCents).toBe(-768);
  });
});

describe('D1-D5 — the system closes a so’m account at zero (U32 A)', () => {
  let d1 = '';
  let payment = '';

  it('D1: a 12,500,000 charge paid with 12,500,000 a month later reads 0, not «$23.44 qarz»', async () => {
    d1 = await client('D1');
    const fxBefore = await fxOf('fx:closing', '1612-02-01', '1612-02-28');
    await pay(d1, 'charge', 12_500_000, SOM, JAN);
    payment = (await pay(d1, 'payment', 12_500_000, SOM, FEB)).id;
    const rows = await fxRows('client', d1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountUsd).toBe('-23.44');
    expect(rows[0]!.fxAnchorId).toBe(payment);
    expect(rows[0]!.txDate).toBe(FEB);
    expect(await clientBalanceUsd(d1)).toBe(0);
    expect(await blockingDebtUsd(d1)).toBe(0);
    expect((await arAging('1612-12-31')).find((row) => row.clientId === d1)).toBeUndefined();
    expect(cents((await fxOf('fx:closing', '1612-02-01', '1612-02-28')) - fxBefore)).toBe(-23.44);
    const summary = (await clientBalances()).find((row) => row.clientId === d1)!;
    expect(summary.fxUsd).toBe(-23.44);
    expect(cents(summary.chargesUsd - summary.paymentsUsd + summary.fxUsd)).toBe(summary.balanceUsd);
  });

  it('D16: the seller’s lenta carries no «0 ZRA» charge for the system’s row', async () => {
    const [fx] = await fxRows('client', d1);
    const feed = await clientFeed(d1, { limit: 200 });
    expect(feed.some((item) => item.id === `tx-${fx!.id}`)).toBe(false);
    expect(feed.some((item) => item.id === `tx-${payment}`)).toBe(true);
  });

  it('D11: the ledger’s own void refuses the system’s row', async () => {
    const [fx] = await fxRows('client', d1);
    await expect(voidTransaction(fx!.id, 'qo‘lda', ctx(), { mayMoveTill: true })).rejects.toMatchObject({
      code: 'fx_system_row',
    });
  });

  it('D5: a second reconcile writes nothing and audits nothing', async () => {
    const all = await fxRows('client', d1, false);
    const audits = async () =>
      (
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(auditLog)
          .where(inArray(auditLog.entityId, all.map((row) => row.id)))
      )[0]!.n;
    const before = await audits();
    for (let i = 0; i < 2; i += 1) {
      await db.transaction((tx) => reconcileFxResidueTx(tx, { clientIds: [d1] }, ctx()));
    }
    expect(await fxRows('client', d1, false)).toHaveLength(all.length);
    expect(await audits()).toBe(before);
  });

  it('D3: voiding the zeroing payment voids the kurs farqi in the same commit', async () => {
    await voidTransaction(payment, 'xato', ctx(), { mayMoveTill: true });
    expect(await fxRows('client', d1)).toHaveLength(0);
    expect(await clientBalanceUsd(d1)).toBe(1000);
  });

  it('D4: a backdated charge reopens the cycle; paying the rest closes it with the WHOLE residue', async () => {
    const id = await client('D4');
    await pay(id, 'charge', 12_500_000, SOM, JAN);
    await pay(id, 'payment', 12_500_000, SOM, FEB);
    expect(await fxRows('client', id)).toHaveLength(1);
    await pay(id, 'charge', 1_000_000, SOM, '1612-01-20'); // $80.00
    expect(await fxRows('client', id)).toHaveLength(0);
    const rest = await pay(id, 'payment', 1_000_000, SOM, '1612-02-20'); // $78.13
    const rows = await fxRows('client', id);
    expect(rows).toHaveLength(1);
    // 1000 + 80 − 976.56 − 78.13 = 25.31
    expect(rows[0]!.amountUsd).toBe('-25.31');
    expect(rows[0]!.fxAnchorId).toBe(rest.id);
    expect(await clientBalanceUsd(id)).toBe(0);
  });

  it('D2: two halves at one rate leave the cent the rounding made — and it closes', async () => {
    const id = await client('D2');
    await pay(id, 'charge', 1_000_000, HALF, JAN); // 76.93
    await pay(id, 'payment', 500_000, HALF, JAN); // 38.47
    await pay(id, 'payment', 500_000, HALF, JAN); // 38.47
    const rows = await fxRows('client', id);
    expect(rows).toHaveLength(1);
    expect(Math.abs(Number(rows[0]!.amountUsd))).toBe(0.01);
    expect(await clientBalanceUsd(id)).toBe(0);
  });
});

describe('D6 — two payments at once close the account exactly once', () => {
  it('the second press waits on the account’s lock and sees the first', async () => {
    const id = await client('D6');
    await pay(id, 'charge', 1_000_000, SOM, JAN); // $80
    const helper = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', {
      max: 1,
      onnotice: () => {},
    });
    const held = await helper.reserve();
    try {
      await held`BEGIN`;
      await held`SELECT pg_advisory_xact_lock(hashtext('client-money'), hashtext(${id}::text))`;
      // The first press, written but not yet committed.
      await held`
        INSERT INTO client_transactions (id, client_id, type, amount, currency, rate_to_usd, amount_usd, tx_date, created_by)
        VALUES (${uuidv4()}, ${id}, 'payment', 500000, ${SOM}, 0.000078125, 39.06, ${FEB}::date, ${actorId})`;
      const second = pay(id, 'payment', 500_000, SOM, FEB);
      let waiting = false;
      for (let i = 0; i < 250 && !waiting; i += 1) {
        const rows = await db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND query ILIKE '%pg_advisory_xact_lock%' AND pid <> pg_backend_pid()`);
        waiting = Number(rows[0]?.n ?? 0) > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 20));
      }
      expect(waiting, 'the second press never reached the account lock').toBe(true);
      await held`COMMIT`;
      await second;
    } finally {
      held.release();
      await helper.end();
    }
    const rows = await fxRows('client', id);
    expect(rows).toHaveLength(1);
    // 80 − 39.06 − 39.06 = 1.88
    expect(rows[0]!.amountUsd).toBe('-1.88');
    expect(await clientBalanceUsd(id)).toBe(0);
  });
});

describe('D7-D8 — a firm and a colleague close the same way (U32 B, C)', () => {
  it('D7: ¥10,000 of truck on credit @0.14 paid ¥10,000 @0.13 — the firm reads 0, the P&L +$100', async () => {
    const firm = await partner('D7');
    const cnyTill = await till(CNY);
    const fxBefore = await fxOf('fx:closing', '1612-02-01', '1612-02-28');
    const entry = await addCostEntry(
      {
        scope: 'batch',
        batchId,
        costTypeId,
        amount: 10_000,
        currency: CNY,
        costDate: '1612-01-15',
        allocationBasis: 'weight',
        partnerId: firm,
      },
      ctx(),
    );
    madeCosts.push(entry.id);
    expect(await partnerBalanceUsd(firm)).toBe(1400);
    await addPartnerTx(
      { partnerId: firm, type: 'payment', amount: 10_000, currency: CNY, txDate: '1612-02-15', accountId: cnyTill },
      ctx(),
      classify,
    );
    const rows = await fxRows('partner', firm);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountUsd).toBe('-100.00');
    expect(await partnerBalanceUsd(firm)).toBe(0);
    expect(cents((await fxOf('fx:closing', '1612-02-01', '1612-02-28')) - fxBefore)).toBe(100);
    await expect(voidPartnerTx(rows[0]!.id, 'qo‘lda', ctx())).rejects.toMatchObject({ code: 'fx_system_row' });
  });

  it('D8: an advance handed out and returned across a rate move — «settled», and no kurs farqi row shown', async () => {
    const [user] = await db
      .insert(users)
      .values({ phone: `+99896${STAMP}${n}`, fullName: `FX hodim ${STAMP}`, passwordHash: 'x', active: true })
      .returning({ id: users.id });
    madeUsers.push(user!.id);
    const staff = await openStaffPartner(user!.id, ctx());
    madePartners.push(staff.id);
    const somTill = await till(SOM);
    await addPartnerTx(
      { partnerId: staff.id, type: 'payment', amount: 1_000_000, currency: SOM, txDate: JAN, accountId: somTill },
      ctx(),
      classify,
    );
    await addPartnerTx(
      { partnerId: staff.id, type: 'receipt', amount: 1_000_000, currency: SOM, txDate: FEB, accountId: somTill },
      ctx(),
      classify,
    );
    expect(await fxRows('partner', staff.id)).toHaveLength(1);
    let view = (await staffAccountView(user!.id))!;
    expect(view.headline).toBe('settled');
    expect(view.rows.some((row) => row.kind === 'fx_diff')).toBe(false);
    // One currency is enough for the per-currency line (U32 Part 1(b)).
    await addPartnerTx(
      { partnerId: staff.id, type: 'payment', amount: 500_000, currency: SOM, txDate: MAR, accountId: somTill },
      ctx(),
      classify,
    );
    view = (await staffAccountView(user!.id))!;
    expect(view.perCurrency).toEqual([{ currency: SOM, amount: -500_000, usd: -40.98 }]);
  });
});

describe('D9 and the accountant’s two-currency close (open question 1, answer b)', () => {
  it('D9: a dollar bill paid in so’m closes nothing by itself', async () => {
    const id = await client('D9');
    await pay(id, 'charge', 100, 'USD', FEB);
    await pay(id, 'payment', 1_250_000, SOM, FEB); // $97.66
    expect(await fxRows('client', id)).toHaveLength(0);
    expect(await clientBalanceUsd(id)).toBe(2.34);

    // «Kurs farqi bilan yopish»: drawn, bounded, a DOLLAR row in fx:adjust.
    expect(await crossCloseOffer(id)).toEqual({ balanceUsd: 2.34, refusal: null });
    await expect(closeCrossCurrencyResidue(id, ctx(), { mayClassify: false })).rejects.toMatchObject({ code: 'forbidden' });
    const adjustBefore = await fxOf('fx:adjust', '1612-02-01', '1612-02-28');
    await closeCrossCurrencyResidue(id, ctx(), classify);
    const rows = await fxRows('client', id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ currency: 'USD', amountUsd: '-2.34', txDate: FEB });
    expect(await clientBalanceUsd(id)).toBe(0);
    expect(cents((await fxOf('fx:adjust', '1612-02-01', '1612-02-28')) - adjustBefore)).toBe(-2.34);
    await expect(closeCrossCurrencyResidue(id, ctx(), classify)).rejects.toMatchObject({ code: 'fx_close_nothing' });
    // The generic void refuses it; its own undo does not.
    await expect(voidTransaction(rows[0]!.id, 'x', ctx(), { mayMoveTill: true })).rejects.toMatchObject({
      code: 'fx_system_row',
    });
    await voidFxClose(rows[0]!.id, 'qayta ko‘rib chiqamiz', ctx(), classify);
    expect(await clientBalanceUsd(id)).toBe(2.34);
  });

  it('refuses a real debt, and a one-currency account', async () => {
    const big = await client('Q24 big');
    await pay(big, 'charge', 1000, 'USD', FEB);
    await pay(big, 'payment', 11_520_000, SOM, FEB); // $900
    await expect(closeCrossCurrencyResidue(big, ctx(), classify)).rejects.toMatchObject({ code: 'fx_close_too_large' });
    const usdOnly = await client('Q24 usd');
    await pay(usdOnly, 'charge', 100, 'USD', FEB);
    await pay(usdOnly, 'payment', 97, 'USD', FEB);
    await expect(closeCrossCurrencyResidue(usdOnly, ctx(), classify)).rejects.toMatchObject({
      code: 'fx_close_single_currency',
    });
  });
});

describe('D12 — what a correction IS (Q12’s split)', () => {
  it('guards the hand «kurs farqi» and reads the kind into the P&L', async () => {
    const yuanOnly = await partner('D12 yuan');
    const cnyTill = await till(CNY);
    await addPartnerTx(
      { partnerId: yuanOnly, type: 'receipt', amount: 1000, currency: CNY, txDate: JAN, accountId: cnyTill },
      ctx(),
      classify,
    );
    const fxAdjust = (over: Record<string, unknown>) =>
      addPartnerTx(
        { partnerId: yuanOnly, type: 'adjust', adjustKind: 'fx', amount: -5, currency: 'USD', txDate: FEB, ...over } as Parameters<
          typeof addPartnerTx
        >[0],
        ctx(),
        classify,
      );
    await expect(fxAdjust({})).rejects.toMatchObject({ code: 'fx_adjust_single_currency' });
    await expect(fxAdjust({ currency: CNY })).rejects.toMatchObject({ code: 'fx_adjust_usd_only' });
    // A dollar correction nobody classified does not make a yuan firm «two-currency».
    await addPartnerTx(
      { partnerId: yuanOnly, type: 'adjust', amount: 3, currency: 'USD', txDate: FEB },
      ctx(),
      { mayClassify: false },
    );
    await expect(fxAdjust({})).rejects.toMatchObject({ code: 'fx_adjust_single_currency' });
    // The classifier must say the kind; the others may not.
    await expect(
      addPartnerTx({ partnerId: yuanOnly, type: 'adjust', amount: 3, currency: 'USD', txDate: FEB }, ctx(), classify),
    ).rejects.toMatchObject({ code: 'adjust_kind_required' });
    await expect(
      addPartnerTx(
        { partnerId: yuanOnly, type: 'adjust', adjustKind: 'correction', amount: 3, currency: 'USD', txDate: FEB },
        ctx(),
        { mayClassify: false },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // The cash buyer: so’m in, dollars out, the residue booked by hand.
    const buyer = await partner('D12 buyer');
    const somTill = await till(SOM);
    const usdTill = await till('USD');
    await addPartnerTx(
      { partnerId: buyer, type: 'receipt', amount: 12_500_000, currency: SOM, txDate: FEB, accountId: somTill },
      ctx(),
      classify,
    ); // $976.56
    await addPartnerTx(
      { partnerId: buyer, type: 'payment', amount: 960, currency: 'USD', txDate: FEB, accountId: usdTill },
      ctx(),
      classify,
    );
    const before = await fxOf('fx:adjust', '1612-02-01', '1612-02-28');
    const gapsBefore = (await pnlGaps('1612-02-01', '1612-02-28')).unclassifiedAdjusts.count;
    await addPartnerTx(
      { partnerId: buyer, type: 'adjust', adjustKind: 'fx', amount: -16.56, currency: 'USD', txDate: FEB },
      ctx(),
      classify,
    );
    expect(cents((await fxOf('fx:adjust', '1612-02-01', '1612-02-28')) - before)).toBe(16.56);
    expect(await partnerBalanceUsd(buyer)).toBe(0);
    await addPartnerTx(
      { partnerId: buyer, type: 'adjust', adjustKind: 'correction', amount: 7, currency: 'USD', txDate: FEB },
      ctx(),
      classify,
    );
    expect(cents((await fxOf('fx:adjust', '1612-02-01', '1612-02-28')) - before)).toBe(16.56);
    // The VED's correction waits unclassified beside the P&L, and is said once.
    const open = await addPartnerTx(
      { partnerId: buyer, type: 'adjust', amount: -7, currency: 'USD', txDate: FEB },
      ctx(),
      { mayClassify: false },
    );
    expect(open.adjustKind).toBeNull();
    expect((await pnlGaps('1612-02-01', '1612-02-28')).unclassifiedAdjusts.count - gapsBefore).toBe(1);
    await setAdjustKind(open.id, 'correction', ctx(), { mayClassify: true, maySeeStaff: true });
    await expect(setAdjustKind(open.id, 'fx', ctx(), { mayClassify: true, maySeeStaff: true })).rejects.toMatchObject({
      code: 'already_classified',
    });
    await expect(setAdjustKind(open.id, 'fx', ctx(), { mayClassify: false, maySeeStaff: true })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('D13 — a deferral does not hold a closed cycle’s residue (money-1)', () => {
  async function deferredDeal(clientId: string) {
    const id = uuidv4();
    n += 1;
    await db.insert(deals).values({
      id,
      code: `R-${STAMP}${n}`,
      clientId,
      stageId,
      createdBy: actorId,
      deferralReason: 'hammasi kelganda',
      deferredBy: actorId,
      deferredAt: new Date(),
      deferUntilAllArrived: true,
    });
    madeDeals.push(id);
    return id;
  }

  it('a so’m job paid in full leaves the unrelated $200 blocking, not −$34.37', async () => {
    const id = await client('D13');
    const deal = await deferredDeal(id);
    await pay(id, 'charge', 125_000_000, SOM, JAN, { dealId: deal }); // $10,000
    await pay(id, 'payment', 125_000_000, SOM, FEB, { dealId: deal }); // $9,765.63
    await pay(id, 'charge', 200, 'USD', FEB);
    expect(await clientBalanceUsd(id)).toBe(200);
    expect(await deferredBalanceUsd(id)).toBe(0);
    expect(await blockingDebtUsd(id)).toBe(200);
    expect((await balancesForClients([id])).get(id)).toEqual({ balanceUsd: 200, deferredUsd: 0 });
  });

  it('two so’m jobs in one cycle, each paid, one deferred — the deferral is 0', async () => {
    const id = await client('D13b');
    const deferred = await deferredDeal(id);
    const [plain] = await db
      .insert(deals)
      .values({ id: uuidv4(), code: `R-${STAMP}${(n += 1)}`, clientId: id, stageId, createdBy: actorId })
      .returning();
    madeDeals.push(plain!.id);
    await pay(id, 'charge', 12_500_000, SOM, JAN, { dealId: deferred });
    await pay(id, 'charge', 12_500_000, SOM, JAN, { dealId: plain!.id });
    await pay(id, 'payment', 12_500_000, SOM, FEB, { dealId: deferred });
    await pay(id, 'payment', 12_500_000, SOM, FEB, { dealId: plain!.id });
    expect(await clientBalanceUsd(id)).toBe(0);
    expect(await deferredBalanceUsd(id)).toBe(0);
  });
});

describe('D17 — a so’m advance handed back in full after the rate moved (money-5)', () => {
  it('the native cap takes it, the reconciler closes the dollars; owing dollars keeps the dollar rule', async () => {
    const id = await client('D17');
    const somTill = await till(SOM);
    await pay(id, 'payment', 125_000_000, SOM, JAN, { accountId: somTill }); // $10,000
    // $10,245.90 on the day — above the dollar rule's $10,000 + $200.
    await addTransaction(
      { clientId: id, type: 'refund', amount: 125_000_000, currency: SOM, txDate: MAR, accountId: somTill },
      ctx(),
    );
    const rows = await fxRows('client', id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountUsd).toBe('-245.90');
    expect(await clientBalanceUsd(id)).toBe(0);

    const owes = await client('D17b');
    await pay(owes, 'payment', 125_000_000, SOM, JAN, { accountId: somTill });
    await pay(owes, 'charge', 100, 'USD', JAN);
    await expect(
      addTransaction(
        { clientId: owes, type: 'refund', amount: 125_000_000, currency: SOM, txDate: MAR, accountId: somTill },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'refund_exceeds_advance' });
  });
});

describe('D10, D14, D15, D18 — history nobody’s rule closes by itself', () => {
  it('D10: a firm’s pre-deploy residue is listed «closable», closed by a person, then kept', async () => {
    const firm = await partner('D10');
    const cnyTill = await till(CNY);
    await historyPartnerRow(firm, { type: 'receipt', amount: 10_000, currency: CNY, rate: 0.14, txDate: JAN, accountId: cnyTill });
    const anchor = await historyPartnerRow(firm, {
      type: 'payment',
      amount: 10_000,
      currency: CNY,
      rate: 0.13,
      txDate: FEB,
      accountId: cnyTill,
    });
    const listed = (await legacyFxResidues({ includeStaff: true })).find((row) => row.ownerId === firm);
    expect(listed).toMatchObject({ state: 'closable', anchorId: anchor, residueUsd: 100 });
    await closeLegacyFxResidue({ ledger: 'partner', ownerId: firm, anchorId: anchor, currency: CNY }, ctx(), {
      mayClassify: true,
      maySeeStaff: true,
    });
    expect(await fxRows('partner', firm)).toHaveLength(1);
    expect(await partnerBalanceUsd(firm)).toBe(0);
    // An unrelated later write keeps the person’s row (the cycle is managed now).
    await addPartnerTx(
      { partnerId: firm, type: 'adjust', adjustKind: 'correction', amount: 5, currency: 'USD', txDate: MAR },
      ctx(),
      classify,
    );
    expect(await fxRows('partner', firm)).toHaveLength(1);
    expect((await legacyFxResidues({ includeStaff: true })).some((row) => row.ownerId === firm)).toBe(false);
  });

  it('D14: a firm closed by hand long ago, its payment voided and typed again — nothing new is written', async () => {
    const firm = await partner('D14');
    const cnyTill = await till(CNY);
    await historyPartnerRow(firm, { type: 'receipt', amount: 10_000, currency: CNY, rate: 0.14, txDate: JAN, accountId: cnyTill });
    const oldPayment = await historyPartnerRow(firm, {
      type: 'payment',
      amount: 10_000,
      currency: CNY,
      rate: 0.13,
      txDate: FEB,
      accountId: cnyTill,
    });
    // #415's documented hand close: a signed dollar correction, kind unsaid.
    const adjust = await historyPartnerRow(firm, { type: 'adjust', amount: -100, currency: 'USD', rate: 1, txDate: '1612-02-20' });
    expect(await partnerBalanceUsd(firm)).toBe(0);
    await voidPartnerTx(oldPayment, 'xato kurs', ctx());
    await addPartnerTx(
      { partnerId: firm, type: 'payment', amount: 10_000, currency: CNY, txDate: '1612-02-15', accountId: cnyTill },
      ctx(),
      classify,
    );
    expect(await fxRows('partner', firm, false)).toHaveLength(0);
    expect(await partnerBalanceUsd(firm)).toBe(0);
    const listed = (await legacyFxResidues({ includeStaff: true })).find((row) => row.ownerId === firm);
    expect(listed?.state).toBe('check');
    expect(listed?.usdAdjusts.map((row) => row.id)).toEqual([adjust]);
    await setAdjustKind(adjust, 'fx', ctx(), { mayClassify: true, maySeeStaff: true });
    expect((await legacyFxResidues({ includeStaff: true })).find((row) => row.ownerId === firm)?.state).toBe('hand');
    expect(await fxRows('partner', firm, false)).toHaveLength(0);
  });

  it('D15: a client’s history is the system’s — unless a same-size dollar row already cancelled it', async () => {
    const plain = await client('D15');
    await historyClientRow(plain, { type: 'charge', amount: 12_500_000, currency: SOM, rate: 0.00008, txDate: JAN });
    const anchor = await historyClientRow(plain, { type: 'payment', amount: 12_500_000, currency: SOM, rate: 0.000078125, txDate: FEB });
    const offset = await client('D15b');
    await historyClientRow(offset, { type: 'charge', amount: 12_500_000, currency: SOM, rate: 0.00008, txDate: JAN });
    await historyClientRow(offset, { type: 'payment', amount: 12_500_000, currency: SOM, rate: 0.000078125, txDate: FEB });
    await historyClientRow(offset, { type: 'payment', amount: 23.44, currency: 'USD', rate: 1, txDate: '1612-02-12' });

    const plan = await fxHistoryPlan();
    expect(plan.clients.autoClientIds).toContain(plain);
    expect(plan.clients.autoClientIds).not.toContain(offset);
    expect(plan.clients.firstChecks.some((row) => row.ownerId === offset)).toBe(true);
    // Only this file's clients: another file's fixtures are theirs (#653).
    const mine = { ...plan, clients: { ...plan.clients, autoClientIds: plan.clients.autoClientIds.filter((id) => id === plain || id === offset) } };
    expect(await applyFxHistory(mine)).toEqual({ clients: 1, rows: 1 });
    const [row] = await fxRows('client', plain);
    expect(row).toMatchObject({ amountUsd: '-23.44', txDate: FEB, fxAnchorId: anchor });
    expect(await fxRows('client', offset, false)).toHaveLength(0);
    // Idempotent: a second run writes nothing.
    expect(await applyFxHistory(mine)).toEqual({ clients: 1, rows: 0 });
  });

  it('D18: «Hammasini yopish» closes the closable and leaves the one to check', async () => {
    const checked = await partner('D18 check');
    const closable = await partner('D18 closable');
    const cnyTill = await till(CNY);
    for (const firm of [checked, closable]) {
      await historyPartnerRow(firm, { type: 'receipt', amount: 10_000, currency: CNY, rate: 0.14, txDate: JAN, accountId: cnyTill });
      await historyPartnerRow(firm, { type: 'payment', amount: 10_000, currency: CNY, rate: 0.13, txDate: FEB, accountId: cnyTill });
    }
    await historyPartnerRow(checked, { type: 'adjust', amount: -100, currency: 'USD', rate: 1, txDate: '1612-02-20' });
    const result = await closeAllLegacyFx(ctx(), { mayClassify: true, maySeeStaff: true });
    expect(result.closed).toBeGreaterThanOrEqual(1);
    expect(await fxRows('partner', closable)).toHaveLength(1);
    expect(await fxRows('partner', checked, false)).toHaveLength(0);
    expect((await legacyFxResidues({ includeStaff: true })).find((row) => row.ownerId === checked)?.state).toBe('check');
    await expect(
      closeLegacyFxResidue(
        {
          ledger: 'partner',
          ownerId: checked,
          anchorId: (await legacyFxResidues({ includeStaff: true })).find((row) => row.ownerId === checked)!.anchorId,
          currency: CNY,
        },
        ctx(),
        { mayClassify: true, maySeeStaff: true },
      ),
    ).rejects.toMatchObject({ code: 'fx_legacy_check' });
  });
});

describe('D19 — the kill-switch stops NEW rows and keeps the managed ones honest', () => {
  class Rollback extends Error {}

  it('switched off: a fresh cycle closes with no row; a managed one still loses its row when reopened', async () => {
    const fresh = await client('D19 fresh');
    const managed = await client('D19 managed');
    await pay(managed, 'charge', 12_500_000, SOM, JAN);
    const zeroing = await pay(managed, 'payment', 12_500_000, SOM, FEB);
    expect(await fxRows('client', managed)).toHaveLength(1);
    // Flipped inside a transaction that is rolled back: the setting is every
    // other file's configuration too (#183).
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO settings (key, value) VALUES ('fx_residue_auto', 'false'::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb`);
        await tx.insert(clientTransactions).values([
          { clientId: fresh, type: 'charge', amount: '12500000', currency: SOM, rateToUsd: '0.00008', amountUsd: '1000.00', txDate: JAN, createdBy: actorId },
          { clientId: fresh, type: 'payment', amount: '12500000', currency: SOM, rateToUsd: '0.000078125', amountUsd: '976.56', txDate: FEB, createdBy: actorId },
        ]);
        await reconcileFxResidueTx(tx, { clientIds: [fresh] }, ctx());
        const freshRows = await tx
          .select({ id: clientTransactions.id })
          .from(clientTransactions)
          .where(and(eq(clientTransactions.clientId, fresh), eq(clientTransactions.type, 'fx_diff')));
        expect(freshRows).toHaveLength(0);
        await tx
          .update(clientTransactions)
          .set({ voidedAt: new Date(), voidedBy: actorId, voidReason: 'x' })
          .where(eq(clientTransactions.id, zeroing.id));
        await reconcileFxResidueTx(tx, { clientIds: [managed] }, ctx());
        const live = await tx
          .select({ id: clientTransactions.id })
          .from(clientTransactions)
          .where(
            and(
              eq(clientTransactions.clientId, managed),
              eq(clientTransactions.type, 'fx_diff'),
              isNull(clientTransactions.voidedAt),
            ),
          );
        expect(live).toHaveLength(0);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await fxRows('client', managed)).toHaveLength(1);
  });
});
