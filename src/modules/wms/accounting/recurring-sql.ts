import { sql, type SQL } from 'drizzle-orm';

/**
 * WHICH recurring months are owed — the one home of the rule (#513), as
 * plain `sql` builders (owner's Q6, 0106).
 *
 * A template is a PROMISE WITH A DAY. Every (template, month) it produces is
 * an «occurrence»; an occurrence is OPEN until a live, non-partial payment of
 * that template for that month closes it, or a live «Bu oy yo'q» with a
 * reason does. The counter, the stop guard and the Balans line all read
 * `dueNowSql` — open AND its day has come — so the three can never disagree
 * about what is owed.
 *
 * Kept apart from the readers and the doors (accounting/recurring.ts) on
 * purpose: nothing here touches a connection, so `updateRecurring` in the
 * service can put the guard inside its transaction without importing the
 * doors that import the service. Raw aliases throughout (`r`, `w`, `o`, `d`,
 * `e`, `s`) and no interpolated drizzle column, so #128's unqualified-column
 * trap has nothing to bind to; every date is bound as an ISO string and cast
 * (#156), and `::timestamp` keeps the session's time zone out of the month
 * arithmetic.
 */

/**
 * The month a posting answers: its own column, or — for a row a writer that
 * predates 0106 left without one (the old app during the migrate window, a
 * test fixture) — the month of its date, 0106's own backfill rule. Alias `e`.
 */
export const postingMonthSql = sql`coalesce(e.recurring_month, date_trunc('month', e.expense_date::timestamp)::date)`;

/** The first of NEXT month: an advance payment has a place (O4), month + 2 has none. */
const horizon = (today: string) => sql`(date_trunc('month', ${today}::date::timestamp) + interval '1 month')::date`;

/**
 * Every occurrence: an ACTIVE template's window from its `due_from`'s month
 * through next month, plus every month that ever carried a posting or a skip
 * of the template — live or voided, active template or not — up to next
 * month. The union is what makes a void re-list its month on a STOPPED
 * template or before `due_from` (M2): a month that once carried a payment was
 * owed. One row per (template, month).
 */
export function occurrencesSql(today: string, recurringId?: string): SQL {
  const onlyR = recurringId ? sql`AND r.id = ${recurringId}::uuid` : sql``;
  const onlyE = recurringId ? sql`AND e.recurring_id = ${recurringId}::uuid` : sql``;
  const onlyS = recurringId ? sql`AND s.recurring_id = ${recurringId}::uuid` : sql``;
  return sql`
    SELECT w.recurring_id, w.month, (w.month + (r.day_of_month - 1)) AS due_date, r.active AS template_active
      FROM (
        SELECT r.id AS recurring_id, m AS month
          FROM recurring_expenses r
         CROSS JOIN LATERAL unnest(ARRAY(
                  SELECT g::date FROM generate_series(date_trunc('month', r.due_from::timestamp),
                                                      ${horizon(today)}::timestamp,
                                                      interval '1 month') AS g)) AS m
         WHERE r.active ${onlyR}
        UNION
        SELECT e.recurring_id, ${postingMonthSql}
          FROM expenses e
         WHERE e.recurring_id IS NOT NULL ${onlyE} AND ${postingMonthSql} <= ${horizon(today)}
        UNION
        SELECT s.recurring_id, s.month
          FROM recurring_skips s
         WHERE s.month <= ${horizon(today)} ${onlyS}
      ) w
      JOIN recurring_expenses r ON r.id = w.recurring_id`;
}

/** Closed by a payment: a live posting of the template for the month that is not a part payment. */
export const paidSql = (rid: SQL, month: SQL) => sql`EXISTS (
  SELECT 1 FROM expenses e
   WHERE e.recurring_id = ${rid} AND ${postingMonthSql} = ${month}
     AND e.voided_at IS NULL AND NOT e.recurring_partial)`;

/** Closed by «Bu oy yo'q». */
export const skippedSql = (rid: SQL, month: SQL) => sql`EXISTS (
  SELECT 1 FROM recurring_skips s
   WHERE s.recurring_id = ${rid} AND s.month = ${month} AND s.voided_at IS NULL)`;

/** THE predicate: occurrences nobody has closed. */
export function openOccurrencesSql(today: string, recurringId?: string): SQL {
  return sql`SELECT o.* FROM (${occurrencesSql(today, recurringId)}) o
              WHERE NOT ${paidSql(sql`o.recurring_id`, sql`o.month`)}
                AND NOT ${skippedSql(sql`o.recurring_id`, sql`o.month`)}`;
}

/**
 * Open AND the day has come — the counter, the stop guard and the Balans
 * line. The 28th's rent is not owed on the 1st and next month's never is:
 * counting them would invite exactly the early press the owner rejected.
 */
export function dueNowSql(today: string, recurringId?: string): SQL {
  return sql`SELECT d.* FROM (${openOccurrencesSql(today, recurringId)}) d
              WHERE d.due_date <= ${today}::date`;
}

/** The live part payments of an occurrence. */
export const partialPartsSql = (rid: SQL, month: SQL) => sql`
  SELECT e.amount, e.currency, e.amount_usd, e.expense_date
    FROM expenses e
   WHERE e.recurring_id = ${rid} AND ${postingMonthSql} = ${month}
     AND e.voided_at IS NULL AND e.recurring_partial`;

/**
 * A payment typed some other way that may be this occurrence's money (M1): a
 * live, unlinked expense of the template's kind (and its person and
 * warehouse when the template names them), from a week before the month to
 * the end of the month after — a salary paid on the 3rd of the next month is
 * the ordinary case. Never an upsale payout (cost-merge's own fence). One
 * home for the row's warning, the «To'landi» refusal and the «Bog'lash»
 * claim, so what the screen offers is exactly what the door accepts.
 */
export const candidatesSql = (rid: SQL, month: SQL) => sql`
  SELECT e.id, e.amount, e.currency, e.expense_date, e.account_id, e.partner_id
    FROM expenses e JOIN recurring_expenses r ON r.id = ${rid}
   WHERE e.recurring_id IS NULL AND e.voided_at IS NULL
     AND e.category_id = r.category_id
     AND (r.employee_id IS NULL OR e.employee_id = r.employee_id)
     AND (r.warehouse_id IS NULL OR e.warehouse_id = r.warehouse_id)
     AND e.expense_date BETWEEN ${month} - 7 AND (${month} + interval '2 months')::date - 1
     AND NOT EXISTS (SELECT 1 FROM calc_offers co WHERE co.payout_expense_id = e.id)`;
