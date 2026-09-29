import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { expenseCategories, kpiPayouts, moneyAccounts, users } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { getSetting } from '../../platform/settings/service';
import { addDays, tashkentDay } from '../../platform/time/tashkent';
import { RECEIPT_BACKDATE_DAYS } from '../receipts/received-day';
import { latestTxDate } from '../finance/dates';
import { rateFor } from '../costing/service';
import { MONEY_EPSILON } from '../calc/upsale';
import { stampedCargoByMonth, stampedCargoBySellerMonth, type Exec, type StaffScope } from './cargo';
import { earnedOnPaid, kpiFor, type KpiRefusal, type KpiResult } from './kpi-engine';
import { firstKpiMonth, kpiVersions, versionFor } from './kpi-table';
import { paidM3ByMonth } from './kpi-paid';
import { addMonths, monthRange, monthsBetween } from './month';

/**
 * The seller's KPI (0117, the owner's 1a-7a): per Tashkent month, his table's
 * rate (kpi-engine.ts) over ALL the month's cargo — the band is the month's —
 * times the PAID part of it (kpi-paid.ts, his 6b), and paid out once a month
 * is CLOSED.
 *
 * THE MONTH CLOSES ON THE 8TH: a prixod may be back-dated up to
 * `RECEIPT_BACKDATE_DAYS` (7) by the office door, so September's cargo is not
 * settled until 7 days of October have passed — paid on the 7th, a
 * back-dated carton of the 30th would land in a month already paid and
 * change its band.
 *
 * PAYABLE IS NETTED PER SELLER across every closed month since the table's
 * first version: Σ earned-on-paid − Σ LIVE payouts, floored at zero. So a
 * month re-counted after a late claim, a correction from A to B, a void or a
 * re-date is absorbed — never paid twice — and money paid beyond what is now
 * earned is shown as «ortiqcha berilgan» and never clawed back; later KPI
 * nets it. A payout is live while its expense is (`e.voided_at IS NULL`):
 * voiding the expense re-opens its money by derivation, no hook.
 */

export type PayKpiError =
  | 'unauthenticated'
  | 'future_date'
  | 'kpi_category_unset'
  | 'non_cash_category'
  | 'fx_missing'
  | 'account_currency_mismatch'
  | 'not_found'
  | 'nothing_to_pay'
  | 'amount_moved'
  | 'kpi_month_refused'
  | 'month_open';

export class KpiError extends Error {
  constructor(
    public readonly code: PayKpiError,
    public readonly month?: string,
    public readonly reason?: KpiRefusal,
  ) {
    super(code);
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Month `YYYY-MM` is closed once `today` has reached the 1st of the next month + the back-date window. */
export function kpiMonthClosed(month: string, today: string): boolean {
  return today >= addDays(`${addMonths(month, 1)}-01`, RECEIPT_BACKDATE_DAYS);
}

/** The newest closed month as of `today`. */
export function lastClosedMonth(today: string): string {
  const previous = addMonths(today.slice(0, 7), -1);
  return kpiMonthClosed(previous, today) ? previous : addMonths(previous, -1);
}

export interface KpiMonthLine {
  month: string;
  receipts: number;
  m3: number;
  kg: number;
  /** The engine's answer over ALL the month's cargo (the band is the month's). */
  result: KpiResult;
  /** Before the table's first version — outside KPI, not a refusal. */
  outside: boolean;
  paidM3: number;
  /** Earned on the paid part at the month's rate; 0 on any refusal. */
  earnedPaidUsd: number;
  closed: boolean;
}

function lineFor(
  month: string,
  cargo: { receipts: number; m3: number; kg: number; unmeasured: string[] } | undefined,
  version: ReturnType<typeof versionFor>,
  paidM3: number,
  today: string,
): KpiMonthLine {
  const c = cargo ?? { receipts: 0, m3: 0, kg: 0, unmeasured: [] };
  const result = kpiFor(version?.cells ?? null, c);
  return {
    month,
    receipts: c.receipts,
    m3: c.m3,
    kg: c.kg,
    result,
    outside: version === null,
    paidM3: Math.round(paidM3 * 10_000) / 10_000,
    earnedPaidUsd: result.ok && version !== null ? earnedOnPaid(paidM3, result.rate) : 0,
    closed: kpiMonthClosed(month, today),
  };
}

/** One month, per seller in scope — /hodimlar's KPI line and the profile's «Bu oy». */
export async function kpiMonth(
  exec: Exec,
  month: string,
  scope: StaffScope,
  today: string = tashkentDay(),
): Promise<Map<string, KpiMonthLine>> {
  const range = monthRange(month);
  const [cargo, versions, paid] = await Promise.all([
    scope.kind === 'own'
      ? stampedCargoByMonth(exec, scope.userId, month, month).then((rows) =>
          rows.map((row) => ({ ...row, sellerId: scope.userId })),
        )
      : stampedCargoBySellerMonth(exec, month, month),
    kpiVersions(exec),
    paidM3ByMonth(exec, { sellerId: scope.kind === 'own' ? scope.userId : undefined, ...range }),
  ]);
  const version = versionFor(versions, month);
  const out = new Map<string, KpiMonthLine>();
  for (const row of cargo) {
    out.set(row.sellerId, lineFor(month, row, version, paid.get(row.sellerId)?.get(month) ?? 0, today));
  }
  return out;
}

export interface KpiPayable {
  /** The last closed month this figure runs through; null = no closed month yet. */
  throughMonth: string | null;
  months: KpiMonthLine[];
  earnedPaidUsd: number;
  paidBeforeUsd: number;
  payableUsd: number;
  /** Paid out beyond what is earned now — shown, never clawed back. */
  overpaidUsd: number;
  /** Months that block the pay, with why (never `no_cargo`, which is a true zero). */
  refusals: { month: string; reason: KpiRefusal; receipts?: string[] }[];
}

/** Σ LIVE payouts per seller — a voided expense re-opens its money. */
export async function livePayoutsUsd(exec: Exec, sellerId?: string): Promise<Map<string, number>> {
  const rows = (await exec.execute(sql`
    SELECT kp.seller_id, coalesce(sum(kp.amount_usd), 0)::text AS usd
      FROM kpi_payouts kp
      JOIN expenses e ON e.id = kp.expense_id AND e.voided_at IS NULL
     WHERE ${sellerId ? sql`kp.seller_id = ${sellerId}::uuid` : sql`true`}
     GROUP BY kp.seller_id`)) as unknown as { seller_id: string; usd: string }[];
  return new Map([...rows].map((row) => [row.seller_id, round2(Number(row.usd))]));
}

/**
 * The netting, ONE sentence for the single seller the payout asks about and
 * the whole company /hodimlar draws (#513): Σ earned-on-paid over the closed
 * months − Σ live payouts, floored at zero, and the months that block.
 */
function payableOf(lines: KpiMonthLine[], paidBefore: number, throughMonth: string | null): KpiPayable {
  const refusals = lines.flatMap((line) =>
    !line.outside && !line.result.ok && line.result.reason !== 'no_cargo'
      ? [{ month: line.month, reason: line.result.reason, receipts: line.result.receipts }]
      : [],
  );
  const earned = round2(lines.reduce((sum, line) => sum + line.earnedPaidUsd, 0));
  return {
    throughMonth,
    months: lines,
    earnedPaidUsd: earned,
    paidBeforeUsd: paidBefore,
    payableUsd: Math.max(0, round2(earned - paidBefore)),
    overpaidUsd: Math.max(0, round2(paidBefore - earned)),
    refusals,
  };
}

/** The closed months KPI runs over as of `today`: the first table's month through the last closed one. */
function payableMonths(first: string | null, today: string): string[] {
  const last = lastClosedMonth(today);
  return first && last >= first ? monthsBetween(first, last) : [];
}

/** The seller's KPI still to pay, netted over every closed month since the first table. */
export async function kpiPayable(exec: Exec, sellerId: string, today: string): Promise<KpiPayable> {
  const [first, versions, payouts] = await Promise.all([
    firstKpiMonth(exec),
    kpiVersions(exec),
    livePayoutsUsd(exec, sellerId),
  ]);
  const months = payableMonths(first, today);
  let lines: KpiMonthLine[] = [];
  if (months.length > 0) {
    const [cargo, paid] = await Promise.all([
      stampedCargoByMonth(exec, sellerId, months[0]!, months.at(-1)!),
      paidM3ByMonth(exec, { sellerId, from: monthRange(months[0]!).from, to: monthRange(months.at(-1)!).to }),
    ]);
    const byMonth = new Map(cargo.map((row) => [row.month, row]));
    const paidByMonth = paid.get(sellerId) ?? new Map<string, number>();
    lines = months.map((month) =>
      lineFor(month, byMonth.get(month), versionFor(versions, month), paidByMonth.get(month) ?? 0, today),
    );
  }
  return payableOf(lines, payouts.get(sellerId) ?? 0, months.at(-1) ?? null);
}

/**
 * Every seller's payable at once — /hodimlar's cards. The same lines and the
 * same netting as `kpiPayable`, read in one pass per source rather than once
 * per seller (#432). A seller with a live payout and no cargo left (moved to
 * another seller by a correction) is listed too — that is «ortiqcha berilgan».
 */
export async function kpiPayableAll(exec: Exec, today: string): Promise<Map<string, KpiPayable>> {
  const [first, versions, payouts] = await Promise.all([firstKpiMonth(exec), kpiVersions(exec), livePayoutsUsd(exec)]);
  const months = payableMonths(first, today);
  const out = new Map<string, KpiPayable>();
  const cargoBySeller = new Map<string, Map<string, { receipts: number; m3: number; kg: number; unmeasured: string[] }>>();
  let paid = new Map<string, Map<string, number>>();
  if (months.length > 0) {
    const [cargo, paidAll] = await Promise.all([
      stampedCargoBySellerMonth(exec, months[0]!, months.at(-1)!),
      paidM3ByMonth(exec, { sellerId: undefined, from: monthRange(months[0]!).from, to: monthRange(months.at(-1)!).to }),
    ]);
    for (const row of cargo) {
      const byMonth = cargoBySeller.get(row.sellerId) ?? new Map();
      byMonth.set(row.month, row);
      cargoBySeller.set(row.sellerId, byMonth);
    }
    paid = paidAll;
  }
  for (const sellerId of new Set([...cargoBySeller.keys(), ...payouts.keys()])) {
    const byMonth = cargoBySeller.get(sellerId) ?? new Map();
    const paidByMonth = paid.get(sellerId) ?? new Map<string, number>();
    const lines = months.map((month) =>
      lineFor(month, byMonth.get(month), versionFor(versions, month), paidByMonth.get(month) ?? 0, today),
    );
    out.set(sellerId, payableOf(lines, payouts.get(sellerId) ?? 0, months.at(-1) ?? null));
  }
  return out;
}

/**
 * Pay a seller their KPI — the whole netted amount through the last closed
 * month, never a typed figure (`payUpsale`'s rule: a typed amount is how a
 * screen says $340 while $200 leaves the till).
 *
 * `expectedUsd` is the amount the payer SAW, used as a compare-and-set: the
 * figure is re-derived inside the transaction under the seller's lock, and if
 * a claim, a payment or a void moved it in between, the press is refused
 * (`amount_moved`) rather than paying a number nobody looked at.
 *
 * Everything that reads the POOL runs before the transaction (#714): the
 * category setting, the till, the rate, the seller. Inside it, only the
 * executor it holds.
 */
export async function payKpi(
  sellerId: string,
  input: { accountId: string; currency: string; expenseDate: string; expectedUsd: number; note?: string },
  ctx: AuditContext,
): Promise<{ expenseId: string; paidUsd: number; throughMonth: string }> {
  if (!ctx.actorId) throw new KpiError('unauthenticated');
  if (input.expenseDate > latestTxDate()) throw new KpiError('future_date');

  const categoryId = String((await getSetting('kpi_expense_category_id')) ?? '').trim();
  if (!categoryId) throw new KpiError('kpi_category_unset');
  const { addExpenseTx, namesMoneyOnNonCash } = await import('../accounting/service');
  if (await namesMoneyOnNonCash(categoryId, { accountId: input.accountId })) throw new KpiError('non_cash_category');
  const rate = await rateFor(input.currency, input.expenseDate);
  if (rate === null) throw new KpiError('fx_missing');
  const [account] = await db
    .select({ currency: moneyAccounts.currency })
    .from(moneyAccounts)
    .where(eq(moneyAccounts.id, input.accountId));
  if (!account) throw new KpiError('not_found');
  if (account.currency !== input.currency) throw new KpiError('account_currency_mismatch');
  const [seller] = await db.select({ id: users.id }).from(users).where(eq(users.id, sellerId));
  if (!seller) throw new KpiError('not_found');
  const [category] = await db
    .select({ id: expenseCategories.id })
    .from(expenseCategories)
    .where(and(eq(expenseCategories.id, categoryId), eq(expenseCategories.active, true)));
  if (!category) throw new KpiError('kpi_category_unset');
  const today = tashkentDay();

  return db.transaction(async (tx) => {
    // A company-sized read, once — JIT would compile it for seconds (0104's
    // measurement), and a hung read must not hold the seller's lock for ever.
    await tx.execute(sql`SET LOCAL jit = off`);
    await tx.execute(sql`SET LOCAL statement_timeout = 20000`);
    // The table is not re-versioned under a payout being computed on it.
    await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtext('kpi:table'))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('kpi:' || ${sellerId}))`);

    const payable = await kpiPayable(tx, sellerId, today);
    if (payable.throughMonth === null) throw new KpiError('month_open');
    const blocked = payable.refusals[0];
    if (blocked) throw new KpiError('kpi_month_refused', blocked.month, blocked.reason);
    if (payable.payableUsd <= MONEY_EPSILON) throw new KpiError('nothing_to_pay');
    if (Math.abs(payable.payableUsd - input.expectedUsd) > MONEY_EPSILON) throw new KpiError('amount_moved');

    const amount = Math.round((payable.payableUsd / rate) * 100) / 100;
    const expense = await addExpenseTx(
      tx,
      {
        categoryId,
        amount,
        currency: input.currency,
        expenseDate: input.expenseDate,
        accountId: input.accountId,
        employeeId: sellerId,
        note: input.note?.trim() || `KPI · ${payable.throughMonth}`,
      } as Parameters<typeof addExpenseTx>[1],
      rate,
      ctx,
    );
    const [payout] = await tx
      .insert(kpiPayouts)
      .values({
        sellerId,
        expenseId: expense.id,
        amountUsd: payable.payableUsd.toFixed(2),
        throughMonth: `${payable.throughMonth}-01`,
        earnedPaidUsd: payable.earnedPaidUsd.toFixed(2),
        paidBeforeUsd: payable.paidBeforeUsd.toFixed(2),
        breakdown: payable.months.map((line) => ({
          month: line.month,
          m3: line.m3,
          kg: line.kg,
          density: line.result.ok ? line.result.density : null,
          tierMaxM3: line.result.ok ? line.result.tierMaxM3 : null,
          bandMaxDensity: line.result.ok ? line.result.bandMaxDensity : null,
          rate: line.result.ok ? line.result.rate : null,
          paidM3: line.paidM3,
          earnedPaidUsd: line.earnedPaidUsd,
        })),
        createdBy: ctx.actorId!,
      })
      .returning({ id: kpiPayouts.id });
    await writeAudit(tx, ctx, {
      entityType: 'expense',
      entityId: expense.id,
      action: 'update',
      after: { kpiPayout: payout!.id, employeeId: sellerId, paidUsd: payable.payableUsd, throughMonth: payable.throughMonth },
    });
    return { expenseId: expense.id, paidUsd: payable.payableUsd, throughMonth: payable.throughMonth };
  });
}

/** The two category pickers /hodimlar carries (`admin.settings.manage`, the upsale picker's precedent). */
export async function setStaffCategory(
  key: 'kpi_expense_category_id' | 'salary_expense_category_id',
  categoryId: string,
  ctx: AuditContext,
): Promise<void> {
  const id = categoryId.trim();
  if (id) {
    const [row] = await db
      .select({ id: expenseCategories.id, cash: expenseCategories.cash })
      .from(expenseCategories)
      .where(and(eq(expenseCategories.id, id), eq(expenseCategories.active, true)));
    if (!row) throw new KpiError('not_found');
    // A KPI payout leaves a till every time (U06), as the upsale's does.
    if (key === 'kpi_expense_category_id' && !row.cash) throw new KpiError('non_cash_category');
  }
  const { setSetting, SETTINGS_AUDIT_ID } = await import('@/modules/platform/settings/service');
  const before = await getSetting(key);
  await setSetting(key, id, ctx.actorId ?? null);
  await writeAudit(db, ctx, {
    entityType: 'settings',
    entityId: SETTINGS_AUDIT_ID,
    action: 'update',
    before: { [key]: before },
    after: { [key]: id },
  });
}
