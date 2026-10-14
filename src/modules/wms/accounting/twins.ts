import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { calendarDaysBetween } from '../../platform/time/tashkent';
import { assertTill, rateFor, tillAmountFor } from '../costing/service';
import { maySeeTillNames } from '../costing/cost-sight';
import { isStaffPartner, staffPartnerSql } from '../partners/staff';
import { mayPickTill } from './till-door';
import { MERGE_DAYS, restoredSql, sameMoney } from './cost-merge';
import type { CompanyMoneySight } from '../finance/scope';
import { commissionPayoutSql } from './payout-sql';
import { writeAudit, type AuditContext } from '../../platform/audit/service';

/**
 * «Bu pul allaqachon yozilganmi?» — the pre-save twin warning (his answer
 * 6, docs/SARFLAR.md §3 + §8.1-8.2) and the map's «tekshirilmagan» count read
 * this ONE rule, so the warning and the count can never disagree.
 *
 * One payment is written twice when the same money lands as a cargo COST
 * (a truck bill, a prixod's customs) and as an EXPENSE in «Xarajatlar». With
 * a kassa on both, the drawer is debited twice; with a kassa on one, the
 * P&L is doubled and only the M4a merge can cure it; with a counterparty on
 * both, the debt is booked twice.
 *
 * The decider is PURE (`twinShape`), over each row's payer KIND, because the
 * money is matched differently per payer (the judge's blocker): a kassa-paid
 * cost keeps its own currency in `amount` while what left the drawer sits in
 * `account_amount`, in the KASSA's currency — and an expense on a kassa must
 * be in the kassa's currency. So a $500 customs bill paid from the som kassa
 * and the same payment typed as a 6 300 000 so'm expense on that kassa are
 * compared in so'm, to the cent; «the same currency» would never see them.
 *
 * The SQL below is only a PREFILTER — a superset of what `twinShape`
 * accepts (the integration file runs the map's count against a brute-force
 * `twinShape` over every pair of the same rows) — and JS is the arbiter, the
 * round-108 last-seven-digits shape (#740).
 */

export type CostPayerKind = 'kassa' | 'staff' | 'firm' | 'none';
export type ExpensePayerKind = 'kassa' | 'staff' | 'firm' | 'cash' | 'book';

export interface TwinCost {
  amount: number;
  currency: string;
  amountUsd: number | null;
  costDate: string;
  accountId: string | null;
  /** What left the kassa, in the KASSA's currency — set exactly when `accountId` is. */
  accountAmount: number | null;
  partnerId: string | null;
  payer: CostPayerKind;
  /**
   * Already joined to an expense by the M4a merge. A kassa-less one is no
   * longer the merge's pair (it refuses it, `cost_taken`), so its double is
   * put right by a void, not by «Birlashtirish».
   */
  merged: boolean;
}

export interface TwinExpense {
  amount: number;
  currency: string;
  amountUsd: number;
  expenseDate: string;
  accountId: string | null;
  partnerId: string | null;
  payer: ExpensePayerKind;
  /** An un-merge restored it within RESTORED_DAYS: the day check is off (#919's round trip). */
  restored: boolean;
}

/**
 * Which kind of double a pair is — it chooses the WORDS and the cure:
 * - `same_kassa`: both name one kassa; the drawer is debited twice;
 * - `kassa_cash`: a kassa-paid (or already merged) cost and an expense the
 *   merge cannot take it with; the P&L is doubled and a void puts it right;
 * - `same_partner`: both book one counterparty's debt;
 * - `debt_paid`: one side books a debt, the other pays the same money from a
 *   kassa as an EXPENSE — the P&L is doubled and the debt still stands (the
 *   judge's J4: a debt's payment is a partner payment, never an expense);
 * - `mergeable`: M4a's own pair (a kassa-less cost × a cash expense) — the
 *   one shape «Birlashtirish» can cure.
 */
export type TwinShape = 'same_kassa' | 'kassa_cash' | 'same_partner' | 'debt_paid' | 'mergeable';

const cents = (value: number) => Math.round(value * 100);

/**
 * What a numeric(…, 2) column stores for a typed JS number, in cents.
 * Postgres rounds the number's decimal TEXT half away from zero, while
 * `Math.round(x * 100)` rounds the binary float: a typed 1.005 is stored as
 * 1.01 and was compared as 1.00, so the warning and the map's count — which
 * reads the stored 1.01 — disagreed about one pair (the review's twins-6).
 * Every candidate figure goes through this before it is compared.
 */
export function storedCents(value: number): number {
  const text = Math.abs(value).toString();
  if (/e/i.test(text)) return Math.sign(value) * Math.round(Math.abs(value) * 100);
  const [whole, fraction = ''] = text.split('.');
  let out = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if ((fraction[2] ?? '0') >= '5') out += 1;
  return value < 0 ? -out : out;
}

/** A candidate figure as the column will hold it. */
const stored = (value: number) => storedCents(value) / 100;

/**
 * Between two currencies the alarm is NARROWER than the merge (the review's
 * twins-1): within TWIN_FX_PCT of the expense's dollars, no $5 floor, and
 * within TWIN_FX_DAYS of each other. The merge's band (2 % or $5, two weeks)
 * is for a person choosing a pair out of a list; as an automatic alarm it
 * made every bill under $250 the twin of any other-currency expense within $5
 * of it — a $40 unloading bill «the same money» as a 470 000 so'm water bill
 * ten days later; the review measured eleven false twins per bill on a busy
 * book, and 2 % alone still left eight. The doubles this arm exists for are
 * customs: a declaration in dollars paid in so'm at the same day's official
 * rate — the same money within a fraction of a percent, typed within days.
 * A cash conversion at a desk's own rate can fall outside it; that pair is
 * still the merge queue's, where a person looks.
 */
export const TWIN_FX_PCT = 0.01;
export const TWIN_FX_DAYS = 3;

/**
 * The alarm's money rule for one cost against one expense: M4a's own
 * `sameMoney`, the restored window included — so every pair the warning calls
 * «mergeable» is one the merge accepts — and, between two currencies, the
 * narrower arm above. An expense an un-merge restored keeps no day check at
 * all (#919's round trip), as in the merge.
 */
export function twinMoney(cost: TwinCost, expense: TwinExpense): boolean {
  const merge = sameMoney(
    [{ id: '', amount: cost.amount, currency: cost.currency, amountUsd: cost.amountUsd, costDate: cost.costDate }],
    expense,
    { window: !expense.restored },
  );
  if (merge !== null) return false;
  if (cost.currency === expense.currency) return true;
  if (!expense.restored && Math.abs(calendarDaysBetween(expense.expenseDate, cost.costDate)) > TWIN_FX_DAYS) return false;
  return Math.abs(cost.amountUsd! - expense.amountUsd) <= Math.abs(expense.amountUsd) * TWIN_FX_PCT + 0.005;
}

const money = twinMoney;

/**
 * Matched in dollars between two currencies rather than to the cent — the
 * warning marks such a line «≈», because a near dollar figure is a likelier
 * coincidence than an exact one, and lists it after the exact ones.
 */
export function twinIsApprox(cost: Pick<TwinCost, 'currency'>, expense: Pick<TwinExpense, 'currency'>, shape: TwinShape): boolean {
  return shape !== 'same_kassa' && cost.currency !== expense.currency;
}

function withinWindow(cost: TwinCost, expense: TwinExpense): boolean {
  return expense.restored || Math.abs(calendarDaysBetween(expense.expenseDate, cost.costDate)) <= MERGE_DAYS;
}

/**
 * The truth table (docs/SARFLAR.md §8.1). Symmetric by construction: it is
 * the same call whichever row is the candidate. A BOOK expense (a non-cash
 * kind — depreciation) is never a twin: it moves no money.
 */
export function twinShape(cost: TwinCost, expense: TwinExpense): TwinShape | null {
  if (expense.payer === 'book') return null;
  switch (cost.payer) {
    case 'kassa':
      if (expense.payer === 'kassa') {
        // Both speak the kassa's currency: to the cent, no FX band.
        return expense.accountId === cost.accountId &&
          cost.accountAmount !== null &&
          cents(cost.accountAmount) === cents(expense.amount) &&
          withinWindow(cost, expense)
          ? 'same_kassa'
          : null;
      }
      if (expense.payer === 'cash') return money(cost, expense) ? 'kassa_cash' : null;
      // staff / firm on the expense: the mirror of «a debt paid as an expense».
      return money(cost, expense) ? 'debt_paid' : null;
    case 'staff':
    case 'firm':
      if (expense.payer === 'kassa') return money(cost, expense) ? 'debt_paid' : null;
      if (expense.payer === cost.payer && expense.partnerId === cost.partnerId) {
        return money(cost, expense) ? 'same_partner' : null;
      }
      return null;
    case 'none':
      if (expense.payer !== 'kassa' && expense.payer !== 'cash') return null;
      if (!money(cost, expense)) return null;
      // Joined already (U02's kassa-less merge): the P&L counts it twice and
      // only a void puts it right — the merge would answer `cost_taken`.
      return cost.merged ? 'kassa_cash' : 'mergeable';
    default: {
      const unreachable: never = cost.payer;
      return unreachable;
    }
  }
}

/**
 * How a double is put right (§8.2's words per shape): only `mergeable` by the
 * merge; a debt's payment typed as an expense by voiding the expense and
 * writing the PAYMENT on the counterparty (`repay`); every other by a void.
 */
export type TwinCure = 'merge' | 'repay' | 'void';

export function twinCure(shape: TwinShape): TwinCure {
  if (shape === 'mergeable') return 'merge';
  if (shape === 'debt_paid') return 'repay';
  return 'void';
}

/**
 * Several costs against one expense (the merge's A3 shape, the judge's J11):
 * the grid's whole sheet, or one truck's bills of one day and one payer. The
 * kassa shape sums what left the drawer; every other sums the costs' money.
 */
export function sumTwinShape(costs: TwinCost[], expense: TwinExpense): TwinShape | null {
  if (costs.length < 2) return null;
  const first = costs[0]!;
  if (!costs.every((c) => c.payer === first.payer && c.accountId === first.accountId && c.partnerId === first.partnerId)) {
    return null;
  }
  return twinShape(sumCosts(costs), expense);
}

/**
 * Several costs as ONE: money adds only within a currency (a mixed set is
 * compared in dollars alone — `sameMoney`'s other branch, which the sentinel
 * currency forces), dollars only when every cost has them, the kassa figure
 * only when every cost carries one. The earliest day stands for the set, so
 * the window is judged by the cost farthest from the expense on that side.
 */
export function sumCosts(costs: TwinCost[]): TwinCost {
  const first = costs[0]!;
  const sameCurrency = costs.every((c) => c.currency === first.currency);
  return {
    ...first,
    currency: sameCurrency ? first.currency : MIXED,
    amount: sameCurrency ? costs.reduce((sum, c) => sum + cents(c.amount), 0) / 100 : 0,
    amountUsd: costs.some((c) => c.amountUsd === null)
      ? null
      : costs.reduce((sum, c) => sum + cents(c.amountUsd!), 0) / 100,
    accountAmount: costs.some((c) => c.accountAmount === null)
      ? null
      : costs.reduce((sum, c) => sum + cents(c.accountAmount!), 0) / 100,
    costDate: costs.map((c) => c.costDate).sort()[0]!,
    merged: costs.some((c) => c.merged),
  };
}

/** Not a currency code (they are three letters): a set of costs in several. */
const MIXED = 'MIXED';

/** One line of the warning, already cut to the reader's sight (§8.2). */
export interface TwinLine {
  /** Opaque to the browser beyond the token — never the id of a row the reader may not open. */
  key: string;
  shape: TwinShape;
  cure: TwinCure;
  book: 'expense' | 'cost';
  date: string;
  /** Null when redacted: a sum's members would otherwise print a colleague's figures one by one. */
  amount: number | null;
  currency: string | null;
  /** Category (an expense) or cost type (a cost); null when redacted. */
  label: string | null;
  /** Truck / prixod / crate / pickup code, or the category; null when redacted. */
  where: string | null;
  kassa: string | null;
  who: string | null;
  /** Whose money the reader may not see: a colleague's cost for an own-only reader. */
  redacted: boolean;
  /** Part of a sum («jami»), not a single row. */
  sum: boolean;
  /** Matched in dollars between two currencies, not to the cent (`twinIsApprox`). */
  approx: boolean;
  /**
   * The grid only: which posted cell (`receiptId:costTypeId`, the grid's own
   * `saved` key) this twin answers; null for the whole sheet's Σ or a form.
   */
  cell: string | null;
}

export interface TwinAnswer {
  lines: TwinLine[];
  /** Twins beyond the five drawn (the similarLeads precedent). */
  more: number;
  /** The single-use acknowledgement «Baribir saqlash» posts back. */
  ackToken: string;
  /** Every twin row id, for the create audit's `twinAck`. Server-side only. */
  ids: string[];
  /**
   * What could not be compared (§8.1, `no_rate` = «cannot check», said in
   * words and never hidden): the candidate itself has no dollar figure, so no
   * other-currency row could be matched against it…
   */
  unchecked: boolean;
  /** …or this many rows on the OTHER book have none (an expense against rate-less truck bills). */
  uncheckedOthers: number;
}

/** How many lines a warning draws; the token covers the full set. */
export const TWIN_LINES = 5;

/**
 * The acknowledgement, bound to the candidate and to what is ALREADY on the
 * candidate's own book (the judge's J10): once the first identical bill is
 * saved, the second one's token differs, so «Baribir» answers one save and
 * never the next. No secret — the person may always save; the token stops a
 * stale screen, not an attacker.
 */
export function twinAckToken(candidate: Record<string, unknown>, twinIds: string[], ownBookIds: string[]): string {
  const payload = JSON.stringify({
    c: Object.keys(candidate)
      .sort()
      .map((k) => [k, candidate[k] ?? null]),
    t: [...twinIds].sort(),
    o: [...ownBookIds].sort(),
  });
  return createHash('sha256').update(payload).digest('hex');
}

/** Thrown by a door that must not write; the action maps it to `{ twins }`. */
export class TwinWarning extends Error {
  constructor(public readonly answer: TwinAnswer) {
    super('twins');
  }
}

// ---------------------------------------------------------------------------
// The prefilter, as SQL. A superset of `twinShape`: every pair the pure rule
// accepts passes it (pinned). Interpolated constants, never a second literal.
// ---------------------------------------------------------------------------

const PCT = sql.raw(String(TWIN_FX_PCT));
const FX_DAYS = sql.raw(String(TWIN_FX_DAYS));

function moneyPrefilter(e: string, c: {
  amount: number;
  currency: string;
  amountUsd: number | null;
  costDate: string;
  accountId: string | null;
  accountAmount: number | null;
}): SQL {
  const ea = sql.raw(e);
  const arms: SQL[] = [sql`(${ea}.currency = ${c.currency} AND ${ea}.amount = round(${c.amount}::numeric, 2))`];
  if (c.accountId && c.accountAmount !== null) {
    arms.push(sql`(${ea}.account_id = ${c.accountId}::uuid AND ${ea}.amount = round(${c.accountAmount}::numeric, 2))`);
  }
  if (c.amountUsd !== null) {
    arms.push(
      sql`(${ea}.currency <> ${c.currency} AND abs(${ea}.amount_usd - ${c.amountUsd}::numeric)
            <= abs(${ea}.amount_usd) * ${PCT} + 0.005
            AND (abs(${ea}.expense_date - ${c.costDate}::date) <= ${FX_DAYS}::int OR ${restored(e)}))`,
    );
  }
  return sql`(${sql.join(arms, sql` OR `)})`;
}

/** The fences on an expense, for either direction (§8.1): live, no recurring posting, no payout. */
function expenseFences(e: string): SQL {
  const ea = sql.raw(e);
  return sql`${ea}.voided_at IS NULL AND ${ea}.recurring_id IS NULL
             AND NOT ${commissionPayoutSql(sql.raw(`${e}.id`))}`;
}

/** The restored predicate over an aliased expense. */
const restored = (e: string) => restoredSql(sql.raw(`${e}.id`));

interface ExpenseRowRaw {
  id: string;
  amount: string;
  currency: string;
  amount_usd: string;
  expense_date: string;
  account_id: string | null;
  partner_id: string | null;
  cash: boolean;
  staff: boolean;
  restored: boolean;
  category: string;
  kassa: string | null;
  who: string | null;
  warehouse_id: string | null;
  warehouse: string | null;
  employee_id: string | null;
}

function expensePayer(row: { account_id: string | null; partner_id: string | null; cash: boolean; staff: boolean }): ExpensePayerKind {
  if (!row.cash) return 'book';
  if (row.account_id) return 'kassa';
  if (row.partner_id) return row.staff ? 'staff' : 'firm';
  return 'cash';
}

function toTwinExpense(row: ExpenseRowRaw): TwinExpense {
  return {
    amount: Number(row.amount),
    currency: row.currency,
    amountUsd: Number(row.amount_usd),
    expenseDate: String(row.expense_date).slice(0, 10),
    accountId: row.account_id,
    partnerId: row.partner_id,
    payer: expensePayer(row),
    restored: row.restored,
  };
}

/** The expenses that could twin `cost`, prefiltered in SQL, near its date (or restored). */
async function expenseCandidates(cost: TwinCost): Promise<ExpenseRowRaw[]> {
  const rows = (await db.execute(sql`
    SELECT e.id, e.amount, e.currency, e.amount_usd, e.expense_date::text AS expense_date,
           e.account_id, e.partner_id, e.warehouse_id, e.employee_id,
           c.cash, c.name AS category,
           (partners.id IS NOT NULL AND ${staffPartnerSql()}) AS staff,
           ${restored('e')} AS restored,
           ma.name AS kassa, u.full_name AS who, w.name AS warehouse
      FROM expenses e
      JOIN expense_categories c ON c.id = e.category_id
      LEFT JOIN partners ON partners.id = e.partner_id
      LEFT JOIN partner_types ON partner_types.id = partners.type_id
      LEFT JOIN money_accounts ma ON ma.id = e.account_id
      LEFT JOIN warehouses w ON w.id = e.warehouse_id
      LEFT JOIN users u ON u.id = e.created_by
     WHERE ${expenseFences('e')}
       AND (e.expense_date BETWEEN ${cost.costDate}::date - ${MERGE_DAYS}::int
                               AND ${cost.costDate}::date + ${MERGE_DAYS}::int
            OR ${restored('e')})
       AND ${moneyPrefilter('e', cost)}
     ORDER BY e.expense_date DESC
     LIMIT 200`)) as unknown as ExpenseRowRaw[];
  return [...rows];
}

interface CostRowRaw {
  id: string;
  amount: string;
  currency: string;
  amount_usd: string | null;
  cost_date: string;
  account_id: string | null;
  account_amount: string | null;
  partner_id: string | null;
  staff: boolean;
  merged_expense_id: string | null;
  scope: string;
  batch_id: string | null;
  entered_by: string;
  type_name: string;
  target_code: string | null;
  kassa: string | null;
  who: string | null;
  /** The warehouses the cost's target stands for — a truck's two ends, a prixod's, a crate's, a pickup's. */
  places: (string | null)[];
}

function costPayer(row: { account_id: string | null; partner_id: string | null; staff: boolean }): CostPayerKind {
  if (row.account_id) return 'kassa';
  if (row.partner_id) return row.staff ? 'staff' : 'firm';
  return 'none';
}

function toTwinCost(row: CostRowRaw): TwinCost {
  return {
    amount: Number(row.amount),
    currency: row.currency,
    amountUsd: row.amount_usd === null ? null : Number(row.amount_usd),
    costDate: String(row.cost_date).slice(0, 10),
    accountId: row.account_id,
    accountAmount: row.account_amount === null ? null : Number(row.account_amount),
    partnerId: row.partner_id,
    payer: costPayer(row),
    merged: row.merged_expense_id !== null,
  };
}

const COST_SELECT = sql`
    SELECT ce.id, ce.amount, ce.currency, ce.amount_usd, ce.cost_date::text AS cost_date,
           ce.account_id, ce.account_amount, ce.partner_id, ce.scope, ce.batch_id, ce.entered_by,
           ce.merged_expense_id,
           ARRAY[b.origin_warehouse_id, b.dest_warehouse_id, r.warehouse_id, cr.warehouse_id, pk.dest_warehouse_id]::text[]
             AS places,
           (partners.id IS NOT NULL AND ${staffPartnerSql()}) AS staff,
           ct.name AS type_name,
           COALESCE(b.code, r.number, cr.code, pk.code) AS target_code,
           ma.name AS kassa, u.full_name AS who
      FROM cost_entries ce
      JOIN cost_types ct ON ct.id = ce.cost_type_id
      LEFT JOIN partners ON partners.id = ce.partner_id
      LEFT JOIN partner_types ON partner_types.id = partners.type_id
      LEFT JOIN batches b ON b.id = ce.batch_id
      LEFT JOIN receipts r ON r.id = ce.receipt_id
      LEFT JOIN crates cr ON cr.id = ce.crate_id
      LEFT JOIN pickups pk ON pk.id = ce.pickup_id
      LEFT JOIN money_accounts ma ON ma.id = ce.account_id
      LEFT JOIN users u ON u.id = ce.entered_by`;

/** Costs that could twin `expense` one-to-one, prefiltered, near its date. */
async function costCandidates(expense: TwinExpense): Promise<CostRowRaw[]> {
  const arms: SQL[] = [sql`(ce.currency = ${expense.currency} AND ce.amount = round(${expense.amount}::numeric, 2))`];
  if (expense.accountId) {
    arms.push(sql`(ce.account_id = ${expense.accountId}::uuid AND ce.account_amount = round(${expense.amount}::numeric, 2))`);
  }
  arms.push(
    sql`(ce.currency <> ${expense.currency} AND ce.amount_usd IS NOT NULL
         AND abs(ce.amount_usd - ${expense.amountUsd}::numeric) <= abs(${expense.amountUsd}::numeric) * ${PCT} + 0.005
         AND abs(ce.cost_date - ${expense.expenseDate}::date) <= ${FX_DAYS}::int)`,
  );
  const rows = (await db.execute(sql`${COST_SELECT}
     WHERE ce.voided_at IS NULL
       AND ce.cost_date BETWEEN ${expense.expenseDate}::date - ${MERGE_DAYS}::int
                            AND ${expense.expenseDate}::date + ${MERGE_DAYS}::int
       AND (${sql.join(arms, sql` OR `)})
     ORDER BY ce.cost_date DESC
     LIMIT 200`)) as unknown as CostRowRaw[];
  return [...rows];
}

/**
 * One truck's bills of one day, one currency and one payer, grouped — the
 * mirror of the completing-sum: does a new expense equal the Σ of several
 * truck bills? One windowed read (PARTITION BY treats two NULL payers as one
 * group, which a tuple IN does not), never a subset search.
 */
async function costGroups(expense: TwinExpense): Promise<CostRowRaw[][]> {
  const near = sql`ce.voided_at IS NULL AND ce.batch_id IS NOT NULL
       AND ce.cost_date BETWEEN ${expense.expenseDate}::date - ${MERGE_DAYS}::int
                            AND ${expense.expenseDate}::date + ${MERGE_DAYS}::int`;
  const rows = (await db.execute(sql`
    SELECT g.* FROM (
      SELECT sub.*,
             count(*) OVER w AS n,
             count(sub.amount_usd) OVER w AS n_usd,
             sum(sub.amount) OVER w AS s_amount,
             sum(sub.account_amount) OVER w AS s_kassa,
             sum(sub.amount_usd) OVER w AS s_usd
        FROM (${COST_SELECT} WHERE ${near}) sub
      WINDOW w AS (PARTITION BY sub.batch_id, sub.cost_date, sub.currency, sub.account_id, sub.partner_id)
    ) g
     WHERE g.n >= 2 AND g.n <= ${SUM_GROUP_CAP}
       AND (g.s_amount = round(${expense.amount}::numeric, 2)
            OR g.s_kassa = round(${expense.amount}::numeric, 2)
            OR (g.n_usd = g.n AND abs(g.s_usd - ${expense.amountUsd}::numeric)
                  <= abs(${expense.amountUsd}::numeric) * ${PCT} + 0.005
                AND abs(g.cost_date::date - ${expense.expenseDate}::date) <= ${FX_DAYS}::int))
     ORDER BY g.batch_id, g.cost_date, g.currency, g.account_id, g.partner_id, g.id`)) as unknown as CostRowRaw[];
  // Unlimited and ordered by the group's own key: a group comes back whole or
  // not at all (a cut group is a wrong sum and a partial acknowledgement).
  // Few rows ever qualify — the sum must equal the expense.
  const groups = new Map<string, CostRowRaw[]>();
  for (const row of rows) {
    const key = [row.batch_id, row.cost_date, row.currency, row.account_id, row.partner_id].join('|');
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()];
}

export interface ReaderSight {
  id: string;
  permissions: ReadonlySet<string>;
  /** `costSightFor(reader).ownOnly` — a colleague's cost twin is redacted for this reader. */
  ownOnly: string | null;
}

/** The candidate COST, as the cost door holds it before the insert. */
export interface CostCandidate {
  scope: 'receipt' | 'batch' | 'crate' | 'pickup';
  targetId: string;
  /** The truck a bill is on (a batch bill, or a grid cell's stamp) — the completing-sum's group. */
  truckId: string | null;
  costTypeId: string;
  amount: number;
  currency: string;
  costDate: string;
  accountId: string | null;
  /** `tillAmountFor`'s answer, already in hand: what leaves the kassa, in its currency. */
  accountAmount: number | null;
  partnerId: string | null;
  partnerIsStaff: boolean;
}

function costCandidateRow(c: CostCandidate, amountUsd: number | null): TwinCost {
  return {
    amount: c.amount,
    currency: c.currency,
    amountUsd,
    costDate: c.costDate,
    accountId: c.accountId,
    accountAmount: c.accountAmount,
    partnerId: c.partnerId,
    payer: c.accountId ? 'kassa' : c.partnerId ? (c.partnerIsStaff ? 'staff' : 'firm') : 'none',
    // A bill not yet written has been merged into nothing.
    merged: false,
  };
}

/**
 * The order a warning lists its twins in (§8.2): an exact match before one
 * found in dollars (`approx`), then the same warehouse, then the smallest day
 * gap, then an expense with no employee (a salary is the least likely to be
 * a truck bill typed twice).
 */
function rank<T extends { date: string; sameWarehouse: boolean; personal: boolean; approx: boolean }>(
  rows: T[],
  day: string,
): T[] {
  const gap = (row: T) => Math.abs(calendarDaysBetween(row.date, day));
  return [...rows].sort(
    (a, b) =>
      Number(a.approx) - Number(b.approx) ||
      Number(b.sameWarehouse) - Number(a.sameWarehouse) ||
      gap(a) - gap(b) ||
      Number(a.personal) - Number(b.personal),
  );
}

/**
 * The twins of a candidate COST, for this reader — null for anybody who is
 * not an expense-book reader (§8.2, the judge's blocker): a non-holder can
 * only write a kassa-less, non-staff cost, which the xarajat-kassa queue,
 * the merge and the map's count already catch; and a twin line would hand the
 * expense book's categories and kassas to people its door refuses.
 */
export async function twinsForCost(
  reader: ReaderSight,
  candidate: CostCandidate,
  opts: { warehouseId?: string | null } = {},
): Promise<TwinAnswer | null> {
  if (!mayPickTill(reader.permissions)) return null;
  const usdOf = dollarsOf();
  const self = costCandidateRow(candidate, await usdOf(candidate));
  const found = await expenseTwinsOf(self, candidate.truckId ? [await truckDayBills(candidate)] : []);
  return {
    ...expenseLines(reader, found, candidate.costDate, opts.warehouseId ?? null, () => null),
    ackToken: twinAckToken(candidateKey(candidate), [...found.keys()], await ownBookCostIds(candidate)),
    // No dollars: an exact twin is still found (one currency, one kassa), but
    // no other-currency expense could be weighed against it.
    unchecked: self.amountUsd === null,
    uncheckedOthers: 0,
  };
}

/**
 * The per-prixod grid's ONE warning for the sheet (§3): every cell checked
 * as a bill of its own (with its truck's completing-sum), then the whole
 * sheet's Σ — one currency, one payer, one date — as one sum. Asked by
 * `addReceiptCostsBulk` after its own refusals and before the first cell is
 * written, through the hook its action passes.
 */
export async function twinsForGrid(
  reader: ReaderSight,
  cells: CostCandidate[],
  opts: { warehouseId?: string | null } = {},
): Promise<TwinAnswer | null> {
  if (!mayPickTill(reader.permissions) || cells.length === 0) return null;
  const usdOf = dollarsOf();
  const rows: TwinCost[] = [];
  for (const cell of cells) rows.push(costCandidateRow(cell, await usdOf(cell)));
  const found = new Map<string, Found>();
  const cellOf = new Map<string, string>();
  for (const [index, cell] of cells.entries()) {
    const own = await expenseTwinsOf(rows[index]!, cell.truckId ? [await truckDayBills(cell)] : []);
    for (const [id, hit] of own) {
      if (found.has(id)) continue;
      found.set(id, hit);
      cellOf.set(id, `${cell.targetId}:${cell.costTypeId}`);
    }
  }
  if (rows.length >= 2) {
    const total = sumCosts(rows);
    for (const row of await expenseCandidates(total)) {
      if (found.has(row.id)) continue;
      const expense = toTwinExpense(row);
      const shape = sumTwinShape(rows, expense);
      if (shape) found.set(row.id, { row, shape, sum: true, approx: twinIsApprox(total, expense, shape) });
    }
  }
  const ownBook: string[] = [];
  for (const cell of cells) ownBook.push(...(await ownBookCostIds(cell)));
  return {
    ...expenseLines(reader, found, cells[0]!.costDate, opts.warehouseId ?? null, (id) => cellOf.get(id) ?? null),
    ackToken: twinAckToken(
      { sheet: cells.map((c) => candidateKey(c)).map((k) => JSON.stringify(k)).sort() },
      [...found.keys()],
      ownBook,
    ),
    unchecked: rows.some((row) => row.amountUsd === null),
    uncheckedOthers: 0,
  };
}

interface Found {
  row: ExpenseRowRaw;
  shape: TwinShape;
  sum: boolean;
  approx: boolean;
}

/** The expenses one cost (and the sums it belongs to) could be a twin of. */
async function expenseTwinsOf(self: TwinCost, groups: TwinCost[][]): Promise<Map<string, Found>> {
  const found = new Map<string, Found>();
  for (const row of await expenseCandidates(self)) {
    const expense = toTwinExpense(row);
    const shape = twinShape(self, expense);
    if (shape) found.set(row.id, { row, shape, sum: false, approx: twinIsApprox(self, expense, shape) });
  }
  // The completing-sum (J11): this bill plus the same truck's live bills of
  // the same day, currency and payer.
  for (const group of groups) {
    if (group.length === 0) continue;
    const members = [self, ...group];
    const total = sumCosts(members);
    for (const row of await expenseCandidates(total)) {
      if (found.has(row.id)) continue;
      const expense = toTwinExpense(row);
      const shape = sumTwinShape(members, expense);
      if (shape) found.set(row.id, { row, shape, sum: true, approx: twinIsApprox(total, expense, shape) });
    }
  }
  return found;
}

/**
 * The expense twins as lines. Every reader here holds finance.expenses (the
 * cost doors' gate), which is the expense book's own door — so nothing on an
 * expense line is cut but the kassa name, which goes through the kassa sight.
 */
function expenseLines(
  reader: ReaderSight,
  found: Map<string, Found>,
  day: string,
  warehouseId: string | null,
  cellOf: (id: string) => string | null,
): Pick<TwinAnswer, 'lines' | 'more' | 'ids'> {
  const seesKassa = maySeeTillNames(reader.permissions);
  const ranked = rank(
    [...found.entries()].map(([id, f]) => ({
      id,
      ...f,
      date: String(f.row.expense_date).slice(0, 10),
      sameWarehouse: Boolean(warehouseId && f.row.warehouse_id === warehouseId),
      personal: f.row.employee_id !== null,
    })),
    day,
  );
  return {
    ids: ranked.map((r) => r.id),
    more: Math.max(0, ranked.length - TWIN_LINES),
    lines: ranked.slice(0, TWIN_LINES).map((r) => ({
      key: lineKey('e', r.id),
      shape: r.shape,
      cure: twinCure(r.shape),
      book: 'expense',
      date: r.date,
      amount: Number(r.row.amount),
      currency: r.row.currency,
      label: r.row.category,
      where: r.row.warehouse,
      kassa: seesKassa ? r.row.kassa : null,
      who: r.row.who,
      redacted: false,
      sum: r.sum,
      approx: r.approx,
      cell: cellOf(r.id),
    })),
  };
}

/** Dollars of a candidate at its day's rate, one rate read per (currency, day). */
function dollarsOf() {
  const rates = new Map<string, Promise<number | null>>();
  return async (c: { amount: number; currency: string; costDate: string }) => {
    const key = `${c.currency}|${c.costDate}`;
    if (!rates.has(key)) rates.set(key, rateFor(c.currency, c.costDate));
    const rate = await rates.get(key)!;
    return rate === null ? null : Math.round(c.amount * rate * 100) / 100;
  };
}

/** A line's key: stable for one row, and never the row's id itself. */
const lineKey = (book: 'e' | 'c', id: string) => createHash('sha256').update(`${book}:${id}`).digest('hex').slice(0, 16);

function candidateKey(c: CostCandidate): Record<string, unknown> {
  return {
    scope: c.scope,
    target: c.targetId,
    type: c.costTypeId,
    amount: c.amount.toFixed(2),
    currency: c.currency,
    date: c.costDate,
    kassa: c.accountId,
    kassaAmount: c.accountAmount === null ? null : c.accountAmount.toFixed(2),
    partner: c.partnerId,
  };
}

/**
 * The same truck's live bills of the candidate's day, currency and payer —
 * ALL of them, or none: a sum over an arbitrary part of the group compares
 * the wrong figure and decides the token by which rows the read happened to
 * return (the review's twins-4). Past SUM_GROUP_CAP the completing-sum is
 * not attempted at all; the one-to-one twins still are.
 */
async function truckDayBills(c: CostCandidate): Promise<TwinCost[]> {
  const rows = (await db.execute(sql`${COST_SELECT}
     WHERE ce.voided_at IS NULL AND ce.batch_id = ${c.truckId}::uuid
       AND ce.cost_date = ${c.costDate}::date AND ce.currency = ${c.currency}
       AND ce.account_id IS NOT DISTINCT FROM ${c.accountId}::uuid
       AND ce.partner_id IS NOT DISTINCT FROM ${c.partnerId}::uuid
     ORDER BY ce.created_at, ce.id
     LIMIT ${SUM_GROUP_CAP + 1}`)) as unknown as CostRowRaw[];
  const list = [...rows];
  return list.length > SUM_GROUP_CAP ? [] : list.map(toTwinCost);
}

/** The most bills one completing-sum adds up — a sheet of every prixod on a full truck. */
const SUM_GROUP_CAP = 500;

/**
 * The ids already on the candidate cost's OWN book with the same target and
 * the same money — the half of the token that makes an ack single-use.
 */
async function ownBookCostIds(c: CostCandidate): Promise<string[]> {
  const column = sql.raw(TARGET_COLUMN[c.scope]);
  const rows = (await db.execute(sql`
    SELECT id FROM cost_entries
     WHERE voided_at IS NULL AND ${column} = ${c.targetId}::uuid
       AND currency = ${c.currency} AND amount = round(${c.amount}::numeric, 2)`)) as unknown as { id: string }[];
  return [...rows].map((r) => r.id);
}

const TARGET_COLUMN: Record<CostCandidate['scope'], string> = {
  receipt: 'receipt_id',
  batch: 'batch_id',
  crate: 'crate_id',
  pickup: 'pickup_id',
};

/**
 * A cost door's parsed input as a twin candidate — the kassa's own figure
 * through the service's own `tillAmountFor` (so a refusal here is the one
 * the save would give), read on the POOL like everything before the insert
 * (#714). `truckId` is the bill's truck: its own (a batch bill) or the grid's
 * stamp.
 */
export async function costCandidateFrom(
  input: {
    scope: CostCandidate['scope'];
    receiptId?: string;
    batchId?: string;
    crateId?: string;
    pickupId?: string;
    costTypeId: string;
    amount: number;
    currency: string;
    costDate: string;
    accountId?: string;
    accountAmount?: number;
    partnerId?: string;
  },
  truckId: string | null = null,
): Promise<CostCandidate> {
  const targetId =
    input.scope === 'receipt'
      ? input.receiptId
      : input.scope === 'batch'
        ? input.batchId
        : input.scope === 'crate'
          ? input.crateId
          : input.pickupId;
  const accountId = input.accountId || null;
  const partnerId = input.partnerId || null;
  const accountAmount = accountId
    ? stored(tillAmountFor(input, (await assertTill(accountId)).currency, input.accountAmount))
    : null;
  return {
    scope: input.scope,
    targetId: targetId!,
    truckId: input.scope === 'batch' ? (input.batchId ?? null) : truckId,
    costTypeId: input.costTypeId,
    // As the column will hold it — the stored row is what the count reads.
    amount: stored(input.amount),
    currency: input.currency,
    costDate: input.costDate,
    accountId,
    accountAmount,
    partnerId,
    partnerIsStaff: partnerId ? await isStaffPartner(partnerId) : false,
  };
}

/** The candidate EXPENSE, as the expense door holds it. */
export interface ExpenseCandidate {
  categoryId: string;
  amount: number;
  currency: string;
  expenseDate: string;
  accountId: string | null;
  partnerId: string | null;
  warehouseId: string | null;
}

/**
 * The twins of a candidate EXPENSE. Its door is `finance.expenses`, so every
 * reader here sees the expense book; what is cut is the COST side for a
 * reader who sees only their own costs (the VED with the kassa grant):
 * a colleague's twin comes back redacted — the book, the date and «boshqa
 * xodim yozgan» — never dropped, because the same-kassa double debit is the
 * very thing the warning exists for.
 */
export async function twinsForExpense(reader: ReaderSight, candidate: ExpenseCandidate): Promise<TwinAnswer | null> {
  const meta = (await db.execute(sql`
    SELECT c.cash,
           (partners.id IS NOT NULL AND ${staffPartnerSql()}) AS staff
      FROM expense_categories c
      LEFT JOIN partners ON partners.id = ${candidate.partnerId}::uuid
      LEFT JOIN partner_types ON partner_types.id = partners.type_id
     WHERE c.id = ${candidate.categoryId}::uuid`)) as unknown as { cash: boolean; staff: boolean | null }[];
  const m = [...meta][0];
  if (!m) return null;
  const rate = await rateFor(candidate.currency, candidate.expenseDate);
  if (rate === null) return null; // addExpense refuses fx_missing on its own
  const amount = stored(candidate.amount);
  const self: TwinExpense = {
    amount,
    currency: candidate.currency,
    amountUsd: Math.round(amount * rate * 100) / 100,
    expenseDate: candidate.expenseDate,
    accountId: candidate.partnerId ? null : candidate.accountId,
    partnerId: candidate.partnerId,
    payer: expensePayer({
      account_id: candidate.partnerId ? null : candidate.accountId,
      partner_id: candidate.partnerId,
      cash: m.cash,
      staff: Boolean(m.staff),
    }),
    restored: false,
  };
  if (self.payer === 'book') return null;

  const found = new Map<string, { row: CostRowRaw; shape: TwinShape; sum: boolean; approx: boolean }>();
  for (const row of await costCandidates(self)) {
    const cost = toTwinCost(row);
    const shape = twinShape(cost, self);
    if (shape) found.set(row.id, { row, shape, sum: false, approx: twinIsApprox(cost, self, shape) });
  }
  for (const group of await costGroups(self)) {
    if (group.some((row) => found.has(row.id))) continue;
    const costs = group.map(toTwinCost);
    const shape = sumTwinShape(costs, self);
    if (!shape) continue;
    const approx = twinIsApprox(sumCosts(costs), self, shape);
    for (const row of group) found.set(row.id, { row, shape, sum: true, approx });
  }

  const seesKassa = maySeeTillNames(reader.permissions);
  const ranked = rank(
    [...found.entries()].map(([id, f]) => ({
      id,
      ...f,
      date: String(f.row.cost_date).slice(0, 10),
      // The expense's warehouse against every place the cost stands for — a
      // truck's two ends, a prixod's, a crate's, a pickup's (§8.2's order).
      sameWarehouse: Boolean(candidate.warehouseId && (f.row.places ?? []).includes(candidate.warehouseId)),
      personal: false,
    })),
    candidate.expenseDate,
  );
  const ids = ranked.map((r) => r.id);
  const lines: TwinLine[] = ranked.slice(0, TWIN_LINES).map((r) => {
    const redacted = reader.ownOnly !== null && r.row.entered_by !== reader.ownOnly;
    return {
      key: lineKey('c', r.id),
      shape: r.shape,
      cure: twinCure(r.shape),
      book: 'cost',
      date: r.date,
      amount: redacted ? null : Number(r.row.amount),
      currency: redacted ? null : r.row.currency,
      label: redacted ? null : r.row.type_name,
      where: redacted ? null : r.row.target_code,
      kassa: redacted || !seesKassa ? null : r.row.kassa,
      who: redacted ? null : r.row.who,
      redacted,
      sum: r.sum,
      approx: r.approx,
      cell: null,
    };
  });
  const ownBook = (await db.execute(sql`
    SELECT id FROM expenses
     WHERE voided_at IS NULL AND category_id = ${candidate.categoryId}::uuid
       AND currency = ${candidate.currency} AND amount = round(${amount}::numeric, 2)
       AND expense_date = ${candidate.expenseDate}::date`)) as unknown as { id: string }[];
  // The truck bills in its window that have NO dollar figure and another
  // currency: they could be this very payment, and nothing can weigh them
  // against it until a rate exists — said, never hidden (§8.1, `no_rate`).
  const [rateless] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM cost_entries
     WHERE voided_at IS NULL AND amount_usd IS NULL AND currency <> ${candidate.currency}
       AND cost_date BETWEEN ${candidate.expenseDate}::date - ${MERGE_DAYS}::int
                         AND ${candidate.expenseDate}::date + ${MERGE_DAYS}::int`)) as unknown as { n: number }[];
  return {
    lines,
    more: Math.max(0, ranked.length - TWIN_LINES),
    ackToken: twinAckToken(
      {
        category: candidate.categoryId,
        amount: candidate.amount.toFixed(2),
        currency: candidate.currency,
        date: candidate.expenseDate,
        kassa: self.accountId,
        partner: candidate.partnerId,
      },
      ids,
      [...ownBook].map((r) => r.id),
    ),
    ids,
    unchecked: false,
    uncheckedOthers: rateless?.n ?? 0,
  };
}

/**
 * The door's one sentence: write, or answer «already written». `posted` is
 * the token the «Baribir saqlash» press carries; a mismatch (a new twin, a
 * changed field, a second identical bill) asks again.
 */
export function mustWarn(answer: TwinAnswer | null, posted: string | null | undefined): boolean {
  if (!answer || answer.ids.length === 0) return false;
  return posted !== answer.ackToken;
}

/** What a warning hands the browser: never the twin ids (§8.2 — a redacted row's id is the row). */
export type TwinView = Omit<TwinAnswer, 'ids'>;

export function twinView(answer: TwinAnswer): TwinView {
  return {
    lines: answer.lines,
    more: answer.more,
    ackToken: answer.ackToken,
    unchecked: answer.unchecked,
    uncheckedOthers: answer.uncheckedOthers,
  };
}

/** What a CLEAN save still says (§8.1): the comparison it could not make, or nothing. */
export type TwinGap = Pick<TwinAnswer, 'unchecked' | 'uncheckedOthers'>;

export function twinGap(answer: TwinAnswer | null): TwinGap | undefined {
  if (!answer || (!answer.unchecked && answer.uncheckedOthers === 0)) return undefined;
  return { unchecked: answer.unchecked, uncheckedOthers: answer.uncheckedOthers };
}

/** The token «Baribir saqlash» posted, or null — never trusted beyond equality. */
export function twinAckOf(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const raw = (input as { twinAck?: unknown }).twinAck;
  return typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw) ? raw : null;
}

/** The staff rule for one partner id, in its own subquery so two payers can each ask it (#513). */
const staffOf = (partnerId: SQL) => sql`EXISTS (SELECT 1 FROM partners
    JOIN partner_types ON partner_types.id = partners.type_id
   WHERE partners.id = ${partnerId} AND ${staffPartnerSql()})`;

/** One side of a listed pair, as the map draws it. */
export interface TwinSide {
  id: string;
  date: string;
  amount: number;
  currency: string;
  /** Cost type (a cost) or category (an expense). */
  label: string;
  /** Truck / prixod / crate / pickup code; null on an expense. */
  where: string | null;
}

export interface TwinPair {
  shape: TwinShape;
  approx: boolean;
  cost: TwinSide;
  expense: TwinSide;
}

/**
 * «🔁 N ta yozuv tekshirilmagan» — the map's count (§1.5, §8.3, J9): the
 * distinct ROWS that have at least one twin nobody answered, by the SAME
 * `twinShape` the warning asks. A pair belongs to the period holding the
 * later of its two dates, so a pair straddling two months is counted once.
 * Rows, not pairs, so it reaches zero once he has answered them: a pair is
 * answered when either row's create audit acknowledged the other (the save
 * that was warned), or by «✓ Ikki xil pul» on the map (`ackTwinPair`) —
 * without that door a pair written before the warning existed could never
 * leave the count.
 *
 * STATED, not counted: the sums (several bills against one expense) — the
 * warning names those at the save, and a sum search over a whole period is a
 * subset search — and a truck bill with no dollar figure (it is counted the
 * day its rate arrives). Uncapped in SQL; the prefilter is the warning's own
 * arms, and the expense side is bounded to the period's window (the review
 * measured 3.6 s when every expense in the company's history was joined).
 */
export async function uncheckedTwinRows(
  _sight: CompanyMoneySight,
  from: string,
  to: string,
): Promise<{ rows: number; pairs: TwinPair[] }> {
  // The expense side ONCE, materialised: its fences, its «restored» and its
  // staff flag are each one probe per expense, never one per (cost, expense)
  // pair — inside the join they ran per PAIR (1.5 s on the review's dense
  // book). Bounded to the period's own window, or restored by an un-merge.
  const candidates = (await db.execute(sql`
    WITH ex AS MATERIALIZED (
      SELECT e.id, e.amount, e.currency, e.amount_usd, e.expense_date, e.account_id, e.partner_id, e.category_id,
             ${restored('e')} AS restored,
             ${staffOf(sql`e.partner_id`)} AS staff
        FROM expenses e
       WHERE ${expenseFences('e')}
         AND e.expense_date <= ${to}::date
         AND (e.expense_date >= ${from}::date - ${MERGE_DAYS}::int OR ${restored('e')})
    )
    SELECT ce.id AS cost_id, ce.amount AS c_amount, ce.currency AS c_currency, ce.amount_usd AS c_usd,
           ce.cost_date::text AS cost_date, ce.account_id AS c_account, ce.account_amount AS c_account_amount,
           ce.partner_id AS c_partner, ce.merged_expense_id AS c_merged,
           ${staffOf(sql`ce.partner_id`)} AS c_staff,
           ct.name AS c_type, COALESCE(b.code, r.number, cr.code, pk.code) AS c_where,
           e.id AS expense_id, e.amount AS e_amount, e.currency AS e_currency, e.amount_usd AS e_usd,
           e.expense_date::text AS expense_date, e.account_id AS e_account, e.partner_id AS e_partner,
           c.cash AS e_cash, c.name AS e_category,
           e.staff AS e_staff,
           e.restored AS e_restored
      FROM cost_entries ce
      JOIN cost_types ct ON ct.id = ce.cost_type_id
      LEFT JOIN batches b ON b.id = ce.batch_id
      LEFT JOIN receipts r ON r.id = ce.receipt_id
      LEFT JOIN crates cr ON cr.id = ce.crate_id
      LEFT JOIN pickups pk ON pk.id = ce.pickup_id
      JOIN ex e
        ON greatest(ce.cost_date, e.expense_date) >= ${from}::date
       AND greatest(ce.cost_date, e.expense_date) <= ${to}::date
       AND (abs(e.expense_date - ce.cost_date) <= ${MERGE_DAYS}::int OR e.restored)
       AND ((e.currency = ce.currency AND e.amount = ce.amount)
            OR (ce.account_id IS NOT NULL AND e.account_id = ce.account_id AND e.amount = ce.account_amount)
            OR (e.currency <> ce.currency AND ce.amount_usd IS NOT NULL
                AND abs(e.amount_usd - ce.amount_usd) <= abs(e.amount_usd) * ${PCT} + 0.005
                AND (abs(e.expense_date - ce.cost_date) <= ${FX_DAYS}::int OR e.restored)))
      JOIN expense_categories c ON c.id = e.category_id
     WHERE ce.voided_at IS NULL
       AND ce.cost_date >= ${from}::date - ${MERGE_DAYS}::int AND ce.cost_date <= ${to}::date`)) as unknown as {
    cost_id: string;
    c_amount: string;
    c_currency: string;
    c_usd: string | null;
    cost_date: string;
    c_account: string | null;
    c_account_amount: string | null;
    c_partner: string | null;
    c_merged: string | null;
    c_staff: boolean;
    c_type: string;
    c_where: string | null;
    expense_id: string;
    e_amount: string;
    e_currency: string;
    e_usd: string;
    expense_date: string;
    e_account: string | null;
    e_partner: string | null;
    e_cash: boolean;
    e_category: string;
    e_staff: boolean;
    e_restored: boolean;
  }[];
  const pairs: TwinPair[] = [];
  for (const r of candidates) {
    const cost = toTwinCost({
      id: r.cost_id,
      amount: r.c_amount,
      currency: r.c_currency,
      amount_usd: r.c_usd,
      cost_date: r.cost_date,
      account_id: r.c_account,
      account_amount: r.c_account_amount,
      partner_id: r.c_partner,
      staff: r.c_staff,
      merged_expense_id: r.c_merged,
    } as CostRowRaw);
    const expense = toTwinExpense({
      id: r.expense_id,
      amount: r.e_amount,
      currency: r.e_currency,
      amount_usd: r.e_usd,
      expense_date: r.expense_date,
      account_id: r.e_account,
      partner_id: r.e_partner,
      cash: r.e_cash,
      staff: r.e_staff,
      restored: r.e_restored,
    } as ExpenseRowRaw);
    const shape = twinShape(cost, expense);
    if (!shape) continue;
    pairs.push({
      shape,
      approx: twinIsApprox(cost, expense, shape),
      cost: { id: r.cost_id, date: cost.costDate, amount: cost.amount, currency: cost.currency, label: r.c_type, where: r.c_where },
      expense: {
        id: r.expense_id,
        date: expense.expenseDate,
        amount: expense.amount,
        currency: expense.currency,
        label: r.e_category,
        where: null,
      },
    });
  }
  if (pairs.length === 0) return { rows: 0, pairs: [] };
  const ids = [...new Set(pairs.flatMap((p) => [p.cost.id, p.expense.id]))];
  const acks = (await db.execute(sql`
    SELECT entity_id, after->'twinAck' AS ack FROM audit_log
     WHERE action IN ('create', 'twin_check') AND entity_type IN ('cost_entry', 'expense')
       AND entity_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
       AND after ? 'twinAck'`)) as unknown as { entity_id: string; ack: unknown }[];
  const acked = new Map<string, Set<string>>();
  for (const a of acks) {
    const list = Array.isArray(a.ack) ? a.ack.filter((x): x is string => typeof x === 'string') : [];
    acked.set(a.entity_id, new Set([...(acked.get(a.entity_id) ?? []), ...list]));
  }
  const open = pairs
    .filter((p) => !acked.get(p.cost.id)?.has(p.expense.id) && !acked.get(p.expense.id)?.has(p.cost.id))
    // Exact before «≈», then the newest — the order the person should look in.
    .sort((a, b) => Number(a.approx) - Number(b.approx) || later(b).localeCompare(later(a)));
  return { rows: new Set(open.flatMap((p) => [p.cost.id, p.expense.id])).size, pairs: open };
}

const later = (pair: TwinPair) => (pair.cost.date > pair.expense.date ? pair.cost.date : pair.expense.date);

export class TwinAckError extends Error {
  constructor(public readonly code: 'not_a_twin' | 'not_found') {
    super(code);
  }
}

/**
 * «✓ Ikki xil pul» on the map: the person who answers the twin warnings at
 * the save (an expense-book reader — the action's door) says two rows are two
 * different payments. Re-decided here from the rows as they stand, so a stale
 * button answers nothing; written as the cost's `twin_check` audit row with
 * the same `twinAck` list a warned save writes, so the count reads both one
 * way. Idempotent by construction — a second press adds an equal row.
 */
export async function ackTwinPair(costId: string, expenseId: string, ctx: AuditContext): Promise<void> {
  const [row] = (await db.execute(sql`
    SELECT ce.amount AS c_amount, ce.currency AS c_currency, ce.amount_usd AS c_usd,
           ce.cost_date::text AS cost_date, ce.account_id AS c_account, ce.account_amount AS c_account_amount,
           ce.partner_id AS c_partner, ce.merged_expense_id AS c_merged, ce.voided_at AS c_voided,
           ${staffOf(sql`ce.partner_id`)} AS c_staff,
           e.amount AS e_amount, e.currency AS e_currency, e.amount_usd AS e_usd,
           e.expense_date::text AS expense_date, e.account_id AS e_account, e.partner_id AS e_partner,
           e.voided_at AS e_voided, c.cash AS e_cash,
           ${staffOf(sql`e.partner_id`)} AS e_staff,
           ${restored('e')} AS e_restored
      FROM cost_entries ce, expenses e
      JOIN expense_categories c ON c.id = e.category_id
     WHERE ce.id = ${costId}::uuid AND e.id = ${expenseId}::uuid`)) as unknown as {
    c_amount: string;
    c_currency: string;
    c_usd: string | null;
    cost_date: string;
    c_account: string | null;
    c_account_amount: string | null;
    c_partner: string | null;
    c_merged: string | null;
    c_voided: unknown;
    c_staff: boolean;
    e_amount: string;
    e_currency: string;
    e_usd: string;
    expense_date: string;
    e_account: string | null;
    e_partner: string | null;
    e_voided: unknown;
    e_cash: boolean;
    e_staff: boolean;
    e_restored: boolean;
  }[];
  if (!row || row.c_voided || row.e_voided) throw new TwinAckError('not_found');
  const shape = twinShape(
    toTwinCost({
      amount: row.c_amount,
      currency: row.c_currency,
      amount_usd: row.c_usd,
      cost_date: row.cost_date,
      account_id: row.c_account,
      account_amount: row.c_account_amount,
      partner_id: row.c_partner,
      staff: row.c_staff,
      merged_expense_id: row.c_merged,
    } as CostRowRaw),
    toTwinExpense({
      amount: row.e_amount,
      currency: row.e_currency,
      amount_usd: row.e_usd,
      expense_date: row.expense_date,
      account_id: row.e_account,
      partner_id: row.e_partner,
      cash: row.e_cash,
      staff: row.e_staff,
      restored: row.e_restored,
    } as ExpenseRowRaw),
  );
  if (!shape) throw new TwinAckError('not_a_twin');
  await writeAudit(db, ctx, {
    entityType: 'cost_entry',
    entityId: costId,
    action: 'twin_check',
    after: { twinAck: [expenseId], shape },
  });
}
