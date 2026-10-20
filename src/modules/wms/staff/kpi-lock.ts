import { sql, type SQL } from 'drizzle-orm';
import { receivedMonthSql } from './cargo';

/**
 * Two KPI facts a writer outside the payout must agree with the payout about
 * (0135, the owner's 6a: «pul to'lab yopilgan oylar qayta hisoblanmaydi»).
 *
 * THE SELLER'S LOCK. `payKpi` serialises on `kpi:<seller>`; anybody who moves
 * what a seller's KPI counts — today the LTL/FTL doors — takes the very same
 * key, so a payout can never be computed on cargo that changes under it. ONE
 * spelling (the bytes are the lock: `'kpi:' || $id` as TEXT, never cast).
 * Several sellers are always taken in SORTED order, as the first locks of the
 * transaction after the deal row (deal → kpi:<sellers> → receipt rows), or two
 * opposite cascades would deadlock (40P01).
 */
export const kpiSellerLockSql = (sellerId: string): SQL =>
  sql`SELECT pg_advisory_xact_lock(hashtext('kpi:' || ${sellerId}))`;

export async function takeKpiSellerLocks(
  tx: { execute(query: SQL): Promise<unknown> },
  sellerIds: Iterable<string | null | undefined>,
): Promise<string[]> {
  const ids = [...new Set([...sellerIds].filter((id): id is string => !!id))].sort();
  for (const id of ids) await tx.execute(kpiSellerLockSql(id));
  return ids;
}

/**
 * A PAID month: the receipt `r` (an alias of `receipts`) carries a seller stamp
 * and its KPI month — the Tashkent month of `received_at`, the cargo reader's
 * own `receivedMonthSql` — is one a LIVE payout to that seller has already
 * priced: on or after the table's first month (an older month carries no KPI
 * money at all, so freezing it would only block the backfill he asked for)
 * and on or before the payout's `through_month`. A payout is live while its
 * expense is (`livePayoutsUsd`'s rule), so voiding it lifts the freeze by
 * derivation, with no hook.
 */
export function kpiPaidMonthSql(r: string): SQL {
  const month = receivedMonthSql(sql.raw(`${r}.received_at`));
  return sql`(${sql.raw(r)}.sales_manager_id IS NOT NULL
    AND ${month} >= (SELECT to_char(min(effective_month), 'YYYY-MM') FROM kpi_rates)
    AND EXISTS (
      SELECT 1 FROM kpi_payouts kp
        JOIN expenses e ON e.id = kp.expense_id AND e.voided_at IS NULL
       WHERE kp.seller_id = ${sql.raw(r)}.sales_manager_id
         AND to_char(kp.through_month, 'YYYY-MM') >= ${month}))`;
}
