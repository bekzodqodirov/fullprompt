import { and, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { clientTransactions, costEntries, expenses } from '../../platform/db/schema';

/**
 * What the cash flow counts, said ONCE for the three readers that must agree
 * about it: the cash flow itself (`cashFlowCore`), the kassa balances
 * (`accountBalances`, `accountBalancesBetween`) and the reconciliation that
 * explains the difference between the two (`cashReconciliation`) — #513. A
 * rule restated in one of them and not the others is a gap the owner reads as
 * money appearing or vanishing between two screens.
 */

/**
 * The expense a merged cost replaced (0101, M4a). The expense row is voided
 * but never deleted — the FK keeps it — and it still carries the day the
 * drawer actually paid.
 */
export const mergedFrom = alias(expenses, 'merged_from');

/**
 * The day a cargo cost's money left the kassa (audit U07): for a merged cost
 * the replaced expense's day, because that is the day the drawer paid and the
 * merge promised «the drawer does not move by a cent» (#1019); otherwise the
 * cost's own day. The two can be up to 14 days apart, so reading the cost's
 * day moved the money across a kassa's opening count (R4) and into another
 * month of the cash flow. Money that MOVED only — the P&L and every accrual
 * reader keep the cost's own day, where the cost belongs.
 *
 * Needs `mergedFrom` LEFT JOINed on `merged_expense_id` in the same query.
 */
export const costCashDay: SQL = sql`coalesce(${mergedFrom.expenseDate}, ${costEntries.costDate})`;

/** A cargo cost the cash flow counts: live, and not settled by a counterparty. */
export function cashCostSql(): SQL {
  return and(isNull(costEntries.voidedAt), isNull(costEntries.partnerId))!;
}

/**
 * A client-ledger row the cash flow counts: a payment that reached us (not a
 * counterparty's account, round 39) or a refund (always out of a kassa, R6a).
 */
export function cashClientTxSql(): SQL {
  return and(
    isNull(clientTransactions.voidedAt),
    sql`(${clientTransactions.type} = 'refund' OR (${clientTransactions.type} = 'payment' AND ${clientTransactions.partnerId} IS NULL))`,
  )!;
}

/**
 * An overhead the cash flow counts: live, in a CASH category (depreciation
 * moves no money — why `expense_categories.cash` exists), and not settled by
 * a counterparty out of their own account. `${expenses}.col`, the table, so
 * the subquery binds to the outer row in a single-table select too (#128).
 */
export function cashExpenseSql(): SQL {
  return and(
    isNull(expenses.voidedAt),
    isNull(expenses.partnerId),
    sql`EXISTS (SELECT 1 FROM expense_categories cat WHERE cat.id = ${expenses}.category_id AND cat.cash)`,
  )!;
}
