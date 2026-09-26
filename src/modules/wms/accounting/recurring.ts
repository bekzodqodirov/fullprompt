import { eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Tx } from '../../platform/db/client';
import { expenseCategories, expenses, moneyAccounts, partners, recurringExpenses, recurringSkips } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { isServerBehind } from '../../platform/db/errors';
import { logger } from '../../platform/logger';
import { calendarDay, tashkentDay } from '../../platform/time/tashkent';
import { rateFor } from '../costing/service';
import { latestTxDate } from '../finance/dates';
import { nativeAmount } from '../finance/money-bounds';
import { chargeForExpenseTx } from '../partners/link';
import { AccountingError, addExpenseTx } from './service';
import { arrearsUsd, closingRule, type Arrears, type PaidPart } from './recurring-math';
import {
  candidatesSql,
  dueNowSql,
  occurrencesSql,
  openOccurrencesSql,
  paidSql,
  partialPartsSql,
  postingMonthSql,
  skippedSql,
} from './recurring-sql';

/**
 * Recurring expenses are paid when the kassa holder actually pays (owner's
 * Q6, 2026-09-25: «fakticheskiy ayrilsin … kassaga mas'ul odam kassadan
 * to'lasin, o'zidan o'zi yechib olinmasin, sistema real hayotda
 * bo'layotgan narsalarni aniqlasin»).
 *
 * Nothing here — and nothing anywhere — posts a month by itself. The old
 * «▶️ Oyni yozish» wrote every template into the chosen month in one press,
 * dated on the template's day and out of the template's kassa, so a rent due
 * on the 28th left the drawer on the 1st while the P&L and the cash flow «to
 * today» never saw it (U21). What replaced it is a DUE LIST (the rule itself
 * lives in `recurring-sql.ts`) and four doors a kassa holder presses:
 *
 *   «To'landi»   — the money left today (or on the day typed): one expense,
 *                  from the kassa or the firm chosen at the press;
 *   «Bog'lash»   — the payment was already typed some other way (a rasxod
 *                  xabari's «Kiritish», the plain expense form): attach it,
 *                  no money moves by a cent;
 *   «Bu oy yo'q» — the month will not be paid, in words;
 *   «Qaytarish»  — undo that.
 *
 * Every door takes the template's row lock first, so two presses on one
 * month — or a press racing the stop guard — serialise instead of both
 * writing. The only writer of an expense's `recurring_*` columns is this
 * file (tests/unit/recurring-wire.test.ts derives it).
 */

export const RECURRING_MONTH = /^\d{4}-\d{2}$/;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PAYER = /^(till|partner):[0-9a-f-]{36}$/i;

/** 'YYYY-MM' → its first day, refusing what postgres would read differently ('2026-9') or not at all ('2026-13'). */
function monthStartOf(month: string): string {
  const start = `${month}-01`;
  if (!RECURRING_MONTH.test(month) || calendarDay(start) === null) throw new AccountingError('bad_month');
  return start;
}

/** The cost form's one «who paid» choice (0101): `till:<id>` or `partner:<id>`. */
export function splitPayer(payer: string | undefined): { accountId: string | null; partnerId: string | null } {
  const value = (payer ?? '').toLowerCase();
  if (value.startsWith('till:')) return { accountId: value.slice(5), partnerId: null };
  if (value.startsWith('partner:')) return { accountId: null, partnerId: value.slice(8) };
  return { accountId: null, partnerId: null };
}

// --- The readers -------------------------------------------------------------
//
// All on the pool, all outside any transaction. Each catches `isServerBehind`
// itself and answers empty, so the home counter, the Balans and the dashboard
// read «nothing due» on a half-applied deploy instead of white-paging — the
// remedy for THAT is the ledger count and `docker compose run --rm migrate`
// (DEPLOY.md), never a code catch; this only keeps the screens standing.

function behind<T>(fallback: T, where: string) {
  return (err: unknown): T => {
    if (isServerBehind(err)) {
      logger.warn({ err, where }, 'recurring: the database is behind this release');
      return fallback;
    }
    throw err;
  };
}

/**
 * The COUNTER: months whose day has come and that nobody has paid, linked or
 * skipped — arrears from earlier months and months re-opened by a void
 * included. The accountant's home and the dashboard read it through
 * `moneyFlowCounts` and `companyBalance` (#513).
 */
export async function recurringDueCount(today: string): Promise<number> {
  return db
    .execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM (${dueNowSql(today)}) x`)
    .then((rows) => Number(rows[0]?.n ?? 0))
    .catch(behind(0, 'recurringDueCount'));
}

export interface DueOccurrence {
  recurringId: string;
  /** `YYYY-MM-01`. */
  month: string;
  /** `YYYY-MM-DD` — the month's day of the template. */
  dueDate: string;
  templateActive: boolean;
  amount: number;
  currency: string;
  note: string | null;
  categoryName: string;
  /** False = a book entry (depreciation): dated on its own day, no kassa. */
  cash: boolean;
  employeeName: string | null;
  warehouseCode: string | null;
  /** The template's DEFAULT kassa / firm — a suggestion for the press, never a posting. */
  accountId: string | null;
  accountName: string | null;
  accountCurrency: string | null;
  accountActive: boolean | null;
  partnerId: string | null;
  partnerName: string | null;
  partnerActive: boolean | null;
  dueNow: boolean;
  overdue: boolean;
  nextMonth: boolean;
  paidParts: { amount: number; currency: string; amountUsd: number; date: string }[];
  /** Hand-typed payments that may be this month's money (M1), newest first, at most five. */
  candidates: {
    id: string;
    amount: number;
    currency: string;
    date: string;
    accountName: string | null;
    partnerName: string | null;
  }[];
}

interface DueRow extends Record<string, unknown> {
  recurring_id: string;
  month: string;
  due_date: string;
  template_active: boolean;
  amount: string;
  currency: string;
  note: string | null;
  category_name: string;
  cash: boolean;
  employee_name: string | null;
  warehouse_code: string | null;
  account_id: string | null;
  account_name: string | null;
  account_currency: string | null;
  account_active: boolean | null;
  partner_id: string | null;
  partner_name: string | null;
  partner_active: boolean | null;
  due_now: boolean;
  overdue: boolean;
  next_month: boolean;
}

/**
 * The LIST: every open occurrence, due or not — this month's whose day has
 * not come and next month's (payable in advance, never counted) included.
 * Dates travel as `YYYY-MM-DD` text (raw `execute` hands back text, #925)
 * and are printed from the string, never through `Intl` month names (#678).
 *
 * TWO statements on purpose, MEASURED: as one, the two per-row lateral
 * reads (part payments, candidates) were costed over the planner's guess
 * for the occurrence set — an empty `recurring_expenses` is assumed ten
 * pages, ~2,000 occurrences — and the estimate crossed `jit_above_cost`:
 * 80 ms of JIT compilation to return zero rows, every render. The details
 * are read for the rows the first statement actually returned, as a VALUES
 * list the planner counts exactly, and not at all when there are none.
 */
export async function recurringDue(today: string): Promise<DueOccurrence[]> {
  const rows = await db
    .execute<DueRow>(dueListSql(today))
    .catch(behind([] as DueRow[], 'recurringDue'));
  if (rows.length === 0) return [];
  const details = await db
    .execute<DueDetailRow>(dueDetailsSql(rows.map((row) => ({ recurringId: row.recurring_id, month: row.month }))))
    .catch(behind([] as DueDetailRow[], 'recurringDue details'));
  const byKey = new Map(details.map((row) => [`${row.recurring_id}:${row.month}`, row]));
  return rows.map((row) => toDueOccurrence(row, byKey.get(`${row.recurring_id}:${row.month}`)));
}

/** The list's first statement — exported so a probe can EXPLAIN exactly what the page runs. */
export function dueListSql(today: string): SQL {
  return sql`
      SELECT d.recurring_id,
             to_char(d.month, 'YYYY-MM-DD') AS month,
             to_char(d.due_date, 'YYYY-MM-DD') AS due_date,
             d.template_active,
             r.amount, r.currency, r.note,
             c.name AS category_name, c.cash,
             u.full_name AS employee_name, wh.code AS warehouse_code,
             r.account_id, ma.name AS account_name, ma.currency AS account_currency, ma.active AS account_active,
             r.partner_id, p.name AS partner_name, p.active AS partner_active,
             (d.due_date <= ${today}::date) AS due_now,
             (d.due_date < ${today}::date) AS overdue,
             (d.month > date_trunc('month', ${today}::date::timestamp)::date) AS next_month
        FROM (${openOccurrencesSql(today)}) d
        JOIN recurring_expenses r ON r.id = d.recurring_id
        JOIN expense_categories c ON c.id = r.category_id
        LEFT JOIN users u ON u.id = r.employee_id
        LEFT JOIN warehouses wh ON wh.id = r.warehouse_id
        LEFT JOIN money_accounts ma ON ma.id = r.account_id
        LEFT JOIN partners p ON p.id = r.partner_id
       ORDER BY d.due_date, c.sort_order, c.name, r.id
    `;
}

/** The part payments and the candidates of exactly these occurrences. */
export function dueDetailsSql(keys: { recurringId: string; month: string }[]): SQL {
  const values = sql.join(
    keys.map((key) => sql`(${key.recurringId}::uuid, ${key.month}::date)`),
    sql`, `,
  );
  return sql`
      SELECT d.recurring_id, to_char(d.month, 'YYYY-MM-DD') AS month,
             coalesce((
               SELECT json_agg(json_build_object('amount', pp.amount, 'currency', pp.currency,
                                                 'amountUsd', pp.amount_usd, 'date', to_char(pp.expense_date, 'YYYY-MM-DD'))
                               ORDER BY pp.expense_date)
                 FROM (${partialPartsSql(sql`d.recurring_id`, sql`d.month`)}) pp), '[]'::json) AS paid_parts,
             coalesce((
               SELECT json_agg(json_build_object('id', k.id, 'amount', k.amount, 'currency', k.currency,
                                                 'expense_date', to_char(k.expense_date, 'YYYY-MM-DD'),
                                                 'account_name', k.account_name, 'partner_name', k.partner_name)
                               ORDER BY k.expense_date DESC)
                 FROM (SELECT cand.*, cma.name AS account_name, cp.name AS partner_name
                         FROM (${candidatesSql(sql`d.recurring_id`, sql`d.month`)}) cand
                         LEFT JOIN money_accounts cma ON cma.id = cand.account_id
                         LEFT JOIN partners cp ON cp.id = cand.partner_id
                        ORDER BY cand.expense_date DESC
                        LIMIT 5) k), '[]'::json) AS candidates
        FROM (VALUES ${values}) AS d(recurring_id, month)
    `;
}

interface DueDetailRow extends Record<string, unknown> {
  recurring_id: string;
  month: string;
  paid_parts: { amount: number | string; currency: string; amountUsd: number | string; date: string }[];
  candidates: {
    id: string;
    amount: number | string;
    currency: string;
    expense_date: string;
    account_name: string | null;
    partner_name: string | null;
  }[];
}

function toDueOccurrence(row: DueRow, detail: DueDetailRow | undefined): DueOccurrence {
  return {
    recurringId: row.recurring_id,
    month: row.month,
    dueDate: row.due_date,
    templateActive: row.template_active,
    amount: Number(row.amount),
    currency: row.currency,
    note: row.note,
    categoryName: row.category_name,
    cash: row.cash,
    employeeName: row.employee_name,
    warehouseCode: row.warehouse_code,
    accountId: row.account_id,
    accountName: row.account_name,
    accountCurrency: row.account_currency,
    accountActive: row.account_active,
    partnerId: row.partner_id,
    partnerName: row.partner_name,
    partnerActive: row.partner_active,
    dueNow: row.due_now,
    overdue: row.overdue,
    nextMonth: row.next_month,
    paidParts: (detail?.paid_parts ?? []).map((part) => ({
      amount: Number(part.amount),
      currency: part.currency,
      amountUsd: Number(part.amountUsd),
      date: part.date,
    })),
    candidates: (detail?.candidates ?? []).map((candidate) => ({
      id: candidate.id,
      amount: Number(candidate.amount),
      currency: candidate.currency,
      date: candidate.expense_date,
      accountName: candidate.account_name,
      partnerName: candidate.partner_name,
    })),
  };
}

/**
 * The MONEY of the counter (M5): what the due, unpaid months still owe, for
 * the Balans's own subtracted line. Same fragment as the counter, so `count`
 * IS the counter's N (the #513 test asserts it); the arithmetic is pure
 * (`arrearsUsd`). Rates at today, once per currency, on the pool.
 */
export async function recurringArrears(today: string): Promise<Arrears> {
  const empty: Arrears = { count: 0, cashCount: 0, usd: 0, unrated: [] };
  try {
    // A payment typed some other way and not yet linked (a rasxod xabari's
    // «Kiritish», the plain form — the flow Q6-1 A prescribes) has already
    // left a kassa, so subtracting the whole month as well took the rent off
    // the Balans twice until somebody pressed «Bog'lash» (review). Each such
    // candidate counts ONCE, against the EARLIEST due month it could be —
    // its window spans two months, and one payment must not pay both.
    const rows = await db.execute<{ amount: string; currency: string; cash: boolean; paid_usd: string }>(sql`
      WITH due AS (SELECT d.recurring_id, d.month FROM (${dueNowSql(today)}) d),
      cand AS (
        SELECT DISTINCT ON (cd.id) due.recurring_id, due.month, cd.amount_usd
          FROM due
          CROSS JOIN LATERAL (${candidatesSql(sql`due.recurring_id`, sql`due.month`)}) cd
         ORDER BY cd.id, due.month
      )
      SELECT r.amount, r.currency, c.cash,
             coalesce((SELECT sum(pp.amount_usd) FROM (${partialPartsSql(sql`due.recurring_id`, sql`due.month`)}) pp), 0)
             + coalesce((SELECT sum(ca.amount_usd) FROM cand ca
                           WHERE ca.recurring_id = due.recurring_id AND ca.month = due.month), 0) AS paid_usd
        FROM due
        JOIN recurring_expenses r ON r.id = due.recurring_id
        JOIN expense_categories c ON c.id = r.category_id
    `);
    const currencies = [...new Set(rows.filter((row) => row.cash).map((row) => row.currency))];
    const rates = new Map(
      await Promise.all(currencies.map(async (code) => [code, await rateFor(code, today)] as const)),
    );
    return arrearsUsd(
      rows.map((row) => ({ amount: Number(row.amount), currency: row.currency, cash: row.cash, paidUsd: Number(row.paid_usd) })),
      rates,
    );
  } catch (err) {
    return behind(empty, 'recurringArrears')(err);
  }
}

export interface ListedSkip {
  id: string;
  recurringId: string;
  month: string;
  reason: string;
  categoryName: string;
  employeeName: string | null;
}

/**
 * Live «Bu oy yo'q» marks recent enough to undo — two months back through
 * next month. A display bound, stated to the owner: an older skip stays
 * closed and is not drawn.
 */
export async function recurringSkipsListed(today: string): Promise<ListedSkip[]> {
  const rows = await db
    .execute<{
      id: string;
      recurring_id: string;
      month: string;
      reason: string;
      category_name: string;
      employee_name: string | null;
    }>(sql`
      SELECT s.id, s.recurring_id, to_char(s.month, 'YYYY-MM-DD') AS month, s.reason,
             c.name AS category_name, u.full_name AS employee_name
        FROM recurring_skips s
        JOIN recurring_expenses r ON r.id = s.recurring_id
        JOIN expense_categories c ON c.id = r.category_id
        LEFT JOIN users u ON u.id = r.employee_id
       WHERE s.voided_at IS NULL
         AND s.month >= (date_trunc('month', ${today}::date::timestamp) - interval '2 months')::date
         AND s.month <= (date_trunc('month', ${today}::date::timestamp) + interval '1 month')::date
       ORDER BY s.month DESC, c.sort_order, c.name
    `)
    .catch(behind([], 'recurringSkipsListed'));
  return rows.map((row) => ({
    id: row.id,
    recurringId: row.recurring_id,
    month: row.month,
    reason: row.reason,
    categoryName: row.category_name,
    employeeName: row.employee_name,
  }));
}

export interface AdvancePosting {
  id: string;
  amount: number;
  currency: string;
  date: string;
  month: string;
  categoryName: string;
  accountName: string | null;
  partnerName: string | null;
}

/**
 * Postings the OLD button made before their own day (G7) — a rent dated the
 * 28th written on the 1st. `created_at`'s Tashkent day + 1 is `latestTxDate`
 * at the moment of writing, the furthest any door since #995 lets a row
 * reach, so a row dated past it can only be the old run's, and it stays
 * true after the day passes: such a posting is named until a person voids it
 * and records the real payment. Nobody un-posts it by migration — only a
 * person knows whether the rent was actually handed over.
 */
export async function advancePostedRecurring(): Promise<{ count: number; rows: AdvancePosting[] }> {
  const rows = await db
    .execute<{
      id: string;
      amount: string;
      currency: string;
      date: string;
      month: string;
      category_name: string;
      account_name: string | null;
      partner_name: string | null;
      total: number;
    }>(sql`
      SELECT e.id, e.amount, e.currency, to_char(e.expense_date, 'YYYY-MM-DD') AS date,
             to_char(${postingMonthSql}, 'YYYY-MM-DD') AS month,
             c.name AS category_name, ma.name AS account_name, p.name AS partner_name,
             count(*) OVER ()::int AS total
        FROM expenses e
        JOIN expense_categories c ON c.id = e.category_id
        LEFT JOIN money_accounts ma ON ma.id = e.account_id
        LEFT JOIN partners p ON p.id = e.partner_id
       WHERE e.recurring_id IS NOT NULL AND e.voided_at IS NULL
         AND e.expense_date > (e.created_at AT TIME ZONE 'Asia/Tashkent')::date + 1
       ORDER BY e.expense_date, e.id
       LIMIT 50
    `)
    .catch(behind([], 'advancePostedRecurring'));
  return {
    count: Number(rows[0]?.total ?? 0),
    rows: rows.map((row) => ({
      id: row.id,
      amount: Number(row.amount),
      currency: row.currency,
      date: row.date,
      month: row.month,
      categoryName: row.category_name,
      accountName: row.account_name,
      partnerName: row.partner_name,
    })),
  };
}

// --- The doors ---------------------------------------------------------------
//
// Gated `finance.expenses` at the action — the kassa holders (`mayPickTill`,
// owner's M2a): the accountant and the admin. The owner's Q6 names «the
// person responsible for the kassa»; no per-kassa holder exists, and his
// still-open Q26 defaults to exactly these people (A).

/** Serialise every writer of one template (pay, link, skip, unskip, the stop guard). */
async function lockTemplate(handle: Tx, recurringId: string): Promise<void> {
  await handle.execute(sql`SELECT id FROM recurring_expenses WHERE id = ${recurringId}::uuid FOR UPDATE`);
}

/** Refuse unless (template, month) is an OPEN occurrence — read under the lock. */
async function assertOccurrenceOpen(handle: Tx, today: string, recurringId: string, monthStart: string): Promise<void> {
  const [row] = await handle.execute<{ paid: boolean; skipped: boolean }>(sql`
    SELECT ${paidSql(sql`o.recurring_id`, sql`o.month`)} AS paid,
           ${skippedSql(sql`o.recurring_id`, sql`o.month`)} AS skipped
      FROM (${occurrencesSql(today, recurringId)}) o
     WHERE o.month = ${monthStart}::date`);
  // Month + 2, a month before `due_from` that never carried a posting, a
  // stopped template's month with nothing on it.
  if (!row) throw new AccountingError('recurring_not_due');
  if (row.skipped) throw new AccountingError('recurring_skipped');
  if (row.paid) throw new AccountingError('recurring_already_paid');
}

/** Does this payment close its month? The person's word, else the pure rule (O3). */
async function closesMonth(
  handle: Tx,
  input: { recurringId: string; monthStart: string; said: boolean | undefined; cash: boolean },
  template: { amount: number; currency: string },
  payment: { amount: number; currency: string },
): Promise<boolean> {
  // A book entry has no instalments.
  if (!input.cash) return true;
  if (input.said !== undefined) return !input.said;
  const parts = await handle.execute<{ amount: string; currency: string }>(
    partialPartsSql(sql`${input.recurringId}::uuid`, sql`${input.monthStart}::date`),
  );
  const paid: PaidPart[] = parts.map((part) => ({ amount: Number(part.amount), currency: part.currency }));
  // Nothing short is ever closed by the system: a first instalment and a
  // deliberately reduced last salary look the same to a sum.
  if (closingRule(template, paid, payment) === 'choose') throw new AccountingError('recurring_partial_unclear');
  return true;
}

export const payRecurringSchema = z.object({
  recurringId: z.string().uuid(),
  /** 'YYYY-MM' — the month this payment answers, which the payment day no longer says. */
  month: z.string().regex(RECURRING_MONTH),
  payer: z.string().regex(PAYER).optional().or(z.literal('')),
  amount: nativeAmount(),
  /** Asked only when a firm pays; a kassa speaks its own currency. */
  currency: z.string().length(3).toUpperCase().optional().or(z.literal('')),
  expenseDate: DATE,
  /** undefined = the person did not say (one button); true/false = the button pressed. */
  partial: z.boolean().optional(),
  /** «Bu boshqa to'lov — baribir yangisini yozish»: drawn only when a candidate exists. */
  confirmNew: z.boolean().default(false),
  note: z.string().trim().max(2000).optional().or(z.literal('')),
});

/**
 * «To'landi» — the money left, so it is written: ONE expense through the
 * ordinary writer, dated on the day it left, out of the kassa (or onto the
 * firm) chosen at the press, and — when a firm paid — its debt in the SAME
 * transaction (M7), so a failed charge rolls the expense back and the press
 * can simply be made again. The template supplies defaults and nothing else.
 */
export async function payRecurring(input: z.input<typeof payRecurringSchema>, ctx: AuditContext) {
  if (!ctx.actorId) throw new AccountingError('unauthenticated');
  const monthStart = monthStartOf(input.month);

  // Every read before the transaction (#714).
  const template = await db.query.recurringExpenses.findFirst({ where: eq(recurringExpenses.id, input.recurringId) });
  if (!template) throw new AccountingError('not_found');
  const [category] = await db
    .select({ cash: expenseCategories.cash })
    .from(expenseCategories)
    .where(eq(expenseCategories.id, template.categoryId));
  const cash = category?.cash !== false;
  const { accountId, partnerId } = splitPayer(input.payer);
  // wc's two words (U13, U06): a cash kind names where the money went, a
  // book entry names nothing.
  if (cash && !accountId && !partnerId) throw new AccountingError('account_or_payer_required');
  if (!cash && (accountId || partnerId)) throw new AccountingError('non_cash_category');

  let currency = template.currency;
  if (accountId) {
    const [till] = await db
      .select({ currency: moneyAccounts.currency, active: moneyAccounts.active })
      .from(moneyAccounts)
      .where(eq(moneyAccounts.id, accountId));
    if (!till || !till.active) throw new AccountingError('account_not_found');
    // DERIVED, never posted: a USD salary paid out of the so'm kassa is
    // written in so'm with the so'm figure typed, so the kassa row is the
    // notes that left the drawer.
    currency = till.currency;
  } else if (partnerId) {
    const [firm] = await db
      .select({ active: partners.active })
      .from(partners)
      .where(eq(partners.id, partnerId));
    if (!firm || !firm.active) throw new AccountingError('partner_not_found');
    currency = (input.currency || template.currency).toUpperCase();
  }

  // A cash payment is dated the day the money left; a book entry on its
  // occurrence's own day (M6) — recording depreciation late does not move it.
  const date = cash ? input.expenseDate : `${monthStart.slice(0, 8)}${String(template.dayOfMonth).padStart(2, '0')}`;
  if (calendarDay(date) === null) throw new AccountingError('validation');
  if (date > latestTxDate()) throw new AccountingError('future_date');
  const rate = await rateFor(currency, date);
  if (rate === null) throw new AccountingError('fx_missing');
  const today = tashkentDay();
  const amount = Number(input.amount);

  return db.transaction(async (tx) => {
    await lockTemplate(tx, template.id);
    await assertOccurrenceOpen(tx, today, template.id, monthStart);
    // Typed some other way already (M1)? Then this press would pay twice:
    // «Bog'lash» attaches it, or the person says it is a different payment.
    if (!input.confirmNew) {
      const [found] = await tx.execute<{ found: boolean }>(
        sql`SELECT EXISTS (${candidatesSql(sql`${template.id}::uuid`, sql`${monthStart}::date`)}) AS found`,
      );
      if (found?.found) throw new AccountingError('recurring_candidate_exists');
    }
    const closes = await closesMonth(
      tx,
      { recurringId: template.id, monthStart, said: input.partial, cash },
      { amount: Number(template.amount), currency: template.currency },
      { amount, currency },
    );
    if (!closes) {
      // A double submit of the same instalment (M10, the server's belt under
      // the greyed button): identical, by the same person, within two minutes.
      const [dup] = await tx.execute<{ dup: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM expenses e
           WHERE e.recurring_id = ${template.id}::uuid AND ${postingMonthSql} = ${monthStart}::date
             AND e.voided_at IS NULL AND e.recurring_partial
             AND e.amount = ${String(amount)}::numeric AND e.currency = ${currency}
             AND e.account_id IS NOT DISTINCT FROM ${accountId}::uuid
             AND e.partner_id IS NOT DISTINCT FROM ${partnerId}::uuid
             AND e.expense_date = ${date}::date
             AND e.created_by = ${ctx.actorId}::uuid
             AND e.created_at > now() - interval '120 seconds'
        ) AS dup`);
      if (dup?.dup) throw new AccountingError('recurring_duplicate_press');
    }
    const row = await addExpenseTx(
      tx,
      {
        categoryId: template.categoryId,
        amount,
        currency,
        expenseDate: date,
        warehouseId: template.warehouseId ?? '',
        employeeId: template.employeeId ?? '',
        accountId: accountId ?? '',
        partnerId: partnerId ?? '',
        note: input.note || template.note || '',
      },
      rate,
      ctx,
      { recurring: { id: template.id, month: monthStart, partial: !closes } },
    );
    // The firm's debt, inside the transaction (M7).
    if (partnerId) await chargeForExpenseTx(tx, row, ctx);
    return row;
  });
}

/**
 * «Bog'lash» — this month was already paid through another door (a rasxod
 * xabari's «Kiritish», the plain expense form): attach THAT payment to it
 * (M1, O1). Attribution only — no amount, date, kassa or firm changes, so no
 * kassa moves by a cent; the `placePayment` precedent, an audited pointer
 * UPDATE and never a money change. A wrong link is corrected by voiding the
 * expense, which re-opens the month.
 */
export async function linkRecurringPayment(
  input: { recurringId: string; month: string; expenseId: string; partial?: boolean },
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new AccountingError('unauthenticated');
  const monthStart = monthStartOf(input.month);
  const template = await db.query.recurringExpenses.findFirst({ where: eq(recurringExpenses.id, input.recurringId) });
  if (!template) throw new AccountingError('not_found');
  const [category] = await db
    .select({ cash: expenseCategories.cash })
    .from(expenseCategories)
    .where(eq(expenseCategories.id, template.categoryId));
  const cash = category?.cash !== false;
  const today = tashkentDay();

  return db.transaction(async (tx) => {
    await lockTemplate(tx, template.id);
    await assertOccurrenceOpen(tx, today, template.id, monthStart);
    // The claim is the candidate rule itself — what the row offered is what
    // the door accepts: another kind, a voided or already-linked expense, an
    // upsale payout or one outside the window answers «not a candidate».
    const [claimed] = await tx.execute<{ id: string; amount: string; currency: string }>(sql`
      SELECT x.id, x.amount, x.currency FROM expenses x
       WHERE x.id = ${input.expenseId}::uuid
         AND EXISTS (SELECT 1 FROM (${candidatesSql(sql`${template.id}::uuid`, sql`${monthStart}::date`)}) c
                      WHERE c.id = x.id)
       FOR UPDATE`);
    if (!claimed) throw new AccountingError('recurring_not_candidate');
    const closes = await closesMonth(
      tx,
      { recurringId: template.id, monthStart, said: input.partial, cash },
      { amount: Number(template.amount), currency: template.currency },
      { amount: Number(claimed.amount), currency: claimed.currency },
    );
    const linked = await tx
      .update(expenses)
      .set({ recurringId: template.id, recurringMonth: monthStart, recurringPartial: !closes })
      .where(sql`${expenses.id} = ${claimed.id}::uuid AND ${expenses.recurringId} IS NULL AND ${expenses.voidedAt} IS NULL`)
      .returning({ id: expenses.id });
    if (linked.length === 0) throw new AccountingError('recurring_not_candidate');
    await writeAudit(tx, ctx, {
      entityType: 'expense',
      entityId: claimed.id,
      action: 'update',
      before: { recurringId: null },
      after: { recurringId: template.id, recurringMonth: monthStart, recurringPartial: !closes },
    });
    return { expenseId: claimed.id, closes };
  });
}

/**
 * «Bu oy yo'q» — this month will not be paid, in words (a person left, a
 * lease paused). Allowed over part payments: it then means «the rest will
 * not be paid». No money moves.
 */
export async function skipRecurring(
  input: { recurringId: string; month: string; reason: string },
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new AccountingError('unauthenticated');
  const monthStart = monthStartOf(input.month);
  const reason = input.reason.trim();
  if (!reason) throw new AccountingError('reason_required');
  const today = tashkentDay();
  return db.transaction(async (tx) => {
    await lockTemplate(tx, input.recurringId);
    await assertOccurrenceOpen(tx, today, input.recurringId, monthStart);
    const [skip] = await tx
      .insert(recurringSkips)
      .values({ recurringId: input.recurringId, month: monthStart, reason, createdBy: ctx.actorId! })
      .returning({ id: recurringSkips.id });
    await writeAudit(tx, ctx, {
      entityType: 'recurring_skip',
      entityId: skip!.id,
      action: 'create',
      after: { recurringId: input.recurringId, month: monthStart, reason },
    });
    return skip!;
  });
}

/**
 * «Qaytarish» — undo a «Bu oy yo'q». The skip is voided, never deleted; its
 * month stays in the occurrence union, so the item is listed again. Under
 * the template's lock like every other writer, so it cannot slip between the
 * stop guard's check and its UPDATE.
 */
export async function unskipRecurring(skipId: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new AccountingError('unauthenticated');
  const [skip] = await db
    .select({ recurringId: recurringSkips.recurringId })
    .from(recurringSkips)
    .where(eq(recurringSkips.id, skipId));
  if (!skip) throw new AccountingError('not_found');
  return db.transaction(async (tx) => {
    await lockTemplate(tx, skip.recurringId);
    const undone = await tx
      .update(recurringSkips)
      .set({ voidedAt: new Date(), voidedBy: ctx.actorId })
      .where(sql`${recurringSkips.id} = ${skipId}::uuid AND ${recurringSkips.voidedAt} IS NULL`)
      .returning({ id: recurringSkips.id, month: recurringSkips.month });
    if (undone.length === 0) throw new AccountingError('not_found');
    await writeAudit(tx, ctx, {
      entityType: 'recurring_skip',
      entityId: skipId,
      action: 'void',
      after: { recurringId: skip.recurringId, month: undone[0]!.month },
    });
  });
}
