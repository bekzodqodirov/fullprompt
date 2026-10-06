import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';

/**
 * «Kim qancha hisobladi» — ONE vocabulary for who calculated a job (the
 * owner's 13c, docs/VED-TARIX.md §2).
 *
 * Three places disagreed about it: the profile's «Bu oy» credited whoever
 * pressed, the queue's speed block credited the HOLDER and counted a
 * price-less close as «done», and the control screen keyed on `sealed_by` —
 * so on one database the speed block gave «VED Demo» four jobs the owner had
 * sealed himself (#513). Every reader asks this module now, and a source
 * fence (`tests/unit/calc-credit-fence.test.ts`) finds the predicate written
 * anywhere else.
 *
 * The rule, in words:
 *   - a SEALED version credits `calc_versions.sealed_by` at `sealed_at`;
 *   - a Готово ANSWER credits `calc_requests.completed_by` at `completed_at`;
 *   - a hand-back, a «lines» ending and a price-less task close credit nobody
 *     — none of them is a price;
 *   - the owner's own seals count like anybody's (stated to him).
 *
 * «Time to price» is the price moment minus `requested_at`, and a
 * correction's `requested_at` is the recalc press — the correction is its own
 * job on the clock.
 */

/**
 * A calculation request that ended with a typed PRICE — the Готово answer.
 *
 * The body is 0093's own CHECK on the column (`> 0 AND <> 'NaN'`), not
 * `IS NOT NULL`: a row from before that CHECK may still hold a 0, and «never a
 * $0» is the history's rule as much as the engine's (review data-migration-7).
 * `answerFloorStandsSql` (the MONEY rule, version-set.ts) is deliberately NOT
 * built on this — it answers what a commission is paid on, and that question
 * has its own five clauses.
 */
export function isAnswerSql(alias = 'r'): SQL {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`isAnswerSql: bad alias ${alias}`);
  return sql.raw(
    `(${alias}.completed_at IS NOT NULL AND ${alias}.completed_via = 'task'` +
      ` AND ${alias}.answer_amount > 0 AND ${alias}.answer_amount <> 'NaN'::numeric)`,
  );
}

/** The same sentence over a row already in hand — the card's «Javob berildi» line. */
export function isAnswer(row: {
  completedAt: Date | string | null;
  completedVia: string | null;
  answerAmount: number | string | null;
}): boolean {
  if (!row.completedAt || row.completedVia !== 'task') return false;
  if (row.answerAmount === null) return false;
  const n = Number(row.answerAmount);
  return Number.isFinite(n) && n > 0;
}

/**
 * Every CREDITED price, as a CTE body: one row per sealed version and one per
 * answer, each naming the person, the price moment and the job's own clock.
 *
 * A CTE rather than two queries, because every reader below groups the two
 * kinds together — the per-VED totals, the queue's speed block — and two
 * aggregations stitched in JS would be two places to forget a clause.
 */
export function creditsSql(): SQL {
  return sql`
    SELECT 'sealed'::text AS kind,
           v.request_id,
           v.sealed_by     AS person_id,
           v.sealed_at     AS at,
           r.requested_at,
           r.due_at
      FROM calc_versions v
      JOIN calc_requests r ON r.id = v.request_id
    UNION ALL
    SELECT 'answer'::text AS kind,
           r.id            AS request_id,
           r.completed_by  AS person_id,
           r.completed_at  AS at,
           r.requested_at,
           r.due_at
      FROM calc_requests r
     WHERE ${isAnswerSql('r')} AND r.completed_by IS NOT NULL`;
}

export interface CreditTotalsRow {
  personId: string;
  name: string;
  sealed: number;
  answered: number;
  /** Mean minutes from the request to its price — null when there were none. */
  avgMinutes: number | null;
  /** Prices given by the job's own deadline. */
  onTime: number;
}

/**
 * Per person, every credited price in `[from, to)` — counts and time only.
 *
 * Never a money sum: answers are typed in three currencies (USD/UZS/CNY), and
 * a column adding them would be a number nobody can read (§7).
 */
export async function creditTotals(range: { from: Date; to: Date }): Promise<CreditTotalsRow[]> {
  const rows = await db.execute<{
    person_id: string;
    name: string | null;
    sealed: number;
    answered: number;
    avg_minutes: string | null;
    on_time: number;
  }>(sql`
    WITH credits AS (${creditsSql()})
    SELECT c.person_id::text AS person_id,
           u.full_name AS name,
           count(*) FILTER (WHERE c.kind = 'sealed')::int AS sealed,
           count(*) FILTER (WHERE c.kind = 'answer')::int AS answered,
           avg(extract(epoch FROM (c.at - c.requested_at)) / 60) AS avg_minutes,
           count(*) FILTER (WHERE c.at <= c.due_at)::int AS on_time
      FROM credits c
      LEFT JOIN users u ON u.id = c.person_id
     WHERE c.at >= ${range.from.toISOString()}::timestamptz
       AND c.at < ${range.to.toISOString()}::timestamptz
     GROUP BY c.person_id, u.full_name
     ORDER BY count(*) DESC, u.full_name
  `);
  return rows.map((r) => ({
    personId: r.person_id,
    name: r.name ?? '—',
    sealed: Number(r.sealed),
    answered: Number(r.answered),
    avgMinutes: r.avg_minutes === null ? null : Math.round(Number(r.avg_minutes)),
    onTime: Number(r.on_time),
  }));
}

/** One person's two counts in a range — the profile's «Bu oy» (staff/my-month.ts). */
export async function creditCountsFor(
  userId: string,
  range: { from: Date; to: Date },
): Promise<{ sealed: number; answered: number }> {
  const [row] = await db.execute<{ sealed: number; answered: number }>(sql`
    WITH credits AS (${creditsSql()})
    SELECT count(*) FILTER (WHERE kind = 'sealed')::int AS sealed,
           count(*) FILTER (WHERE kind = 'answer')::int AS answered
      FROM credits
     WHERE person_id = ${userId}::uuid
       AND at >= ${range.from.toISOString()}::timestamptz
       AND at < ${range.to.toISOString()}::timestamptz
  `);
  return { sealed: Number(row?.sealed ?? 0), answered: Number(row?.answered ?? 0) };
}
