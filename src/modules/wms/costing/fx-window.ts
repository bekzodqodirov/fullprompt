import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../../platform/db/client';

/**
 * Which dates a dated FX rate governs (0103, Q18, design §5.6.2) — `rateFor`'s
 * own rule turned around: the newest rate on or before a day governs it, and
 * a day before the currency's EARLIEST rate falls back to that earliest one.
 * So the row at `day` governs [day, next rate) — and, when it is the earliest,
 * every date before it too (`from: null`). A correction of an existing date
 * and a newly typed backdated one have the same window. Pure.
 */
export function fxWindow(rateDates: string[], day: string): { from: string | null; to: string | null } {
  const earlier = rateDates.some((date) => date < day);
  const later = rateDates.filter((date) => date > day).sort();
  return { from: earlier ? day : null, to: later[0] ?? null };
}

/** The same through the transaction (two indexed reads) — after the rate row is written. */
export async function fxWindowTx(tx: Tx, currency: string, day: string): Promise<{ from: string | null; to: string | null }> {
  const [row] = (await tx.execute(sql`
    SELECT (SELECT max(effective_date)::text FROM fx_rates WHERE currency = ${currency} AND effective_date < ${day}::date) AS before,
           (SELECT min(effective_date)::text FROM fx_rates WHERE currency = ${currency} AND effective_date > ${day}::date) AS after
  `)) as unknown as { before: string | null; after: string | null }[];
  return fxWindow([row?.before, row?.after].filter((date): date is string => Boolean(date)), day);
}

/**
 * `rateFor`'s rule as SQL for a row: the newest rate on or before its date,
 * else the currency's earliest. Pass `table.currency` / `table.<date>` as raw
 * column SQL — never a drizzle column in a single-table select (#128).
 */
export function governingRateSql(currency: SQL, day: SQL): SQL {
  return sql`coalesce(
    (SELECT gr.rate_to_usd FROM fx_rates gr WHERE gr.currency = ${currency} AND gr.effective_date <= ${day}
      ORDER BY gr.effective_date DESC LIMIT 1),
    (SELECT gr.rate_to_usd FROM fx_rates gr WHERE gr.currency = ${currency} ORDER BY gr.effective_date ASC LIMIT 1))`;
}

/** A date window as SQL clauses built in JS — never `($from IS NULL OR …)` over an untyped parameter (#156). */
export function windowSql(column: SQL, window: { from: string | null; to: string | null }): SQL {
  return sql`${window.from ? sql` AND ${column} >= ${window.from}::date` : sql``}${
    window.to ? sql` AND ${column} < ${window.to}::date` : sql``
  }`;
}
