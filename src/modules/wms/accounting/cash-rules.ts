import { and, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { accountTransfers, clientTransactions, costEntries, expenses } from '../../platform/db/schema';

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

// ---------------------------------------------------------------------------
// Kurs farqi (0103, the owner's Q12 A / Q13 A). A kassa-paid cost carries two
// dollar figures: `amount_usd`, the tannarx at the day's table rate, and
// `account_amount_usd`, what LEFT the kassa (the payment, frozen). The P&L
// keeps the tannarx in its cost rows and puts the difference on «Kurs farqi
// (kassa)»; the cash flow keeps the tannarx on its cargo row and adds the
// same difference as an exchange gain or loss — so a kassa's real dollars are
//   cargo `amount_usd` − `costKassaFxUsd` + `costKassaUnratedUsd` = `costKassaUsd`
// for every kassa-paid row, in every null-state (the fx-kassa integration
// tests walk all four). Built from the table, `${costEntries}.col`, so a
// correlated subquery binds to the outer row (#128).
// ---------------------------------------------------------------------------

/**
 * The kassa's dollars of a cost: what LEFT the kassa when it is known, else
 * the cost's own dollars, else 0. The kassa ledger's cost statement.
 */
export const costKassaUsd: SQL = sql`coalesce(${costEntries.accountAmountUsd}, ${costEntries.amountUsd}, 0)`;

/** A kassa-paid cost whose kassa side has no dollars at all (both figures missing). */
export const costKassaNoUsd: SQL = sql`(${costEntries.accountAmountUsd} IS NULL AND ${costEntries.amountUsd} IS NULL)`;

/**
 * Q13: the realised exchange difference of a kassa-paid cost, + = gain — the
 * cost at the table rate minus what the kassa paid. 0 when either side has
 * no dollars (named beside the report, never guessed).
 */
export const costKassaFxUsd: SQL = sql`(CASE WHEN ${costEntries.accountId} IS NOT NULL
  AND ${costEntries.accountAmountUsd} IS NOT NULL AND ${costEntries.amountUsd} IS NOT NULL
  THEN ${costEntries.amountUsd} - ${costEntries.accountAmountUsd} ELSE 0 END)`;

/**
 * Money that LEFT a kassa for a cost whose own currency has no rate yet: the
 * kassa's dollars are known, the tannarx is not. The cash flow counts it on
 * its own row; the P&L names the cost as unconverted, never guesses it.
 */
export const costKassaUnratedUsd: SQL = sql`(CASE WHEN ${costEntries.accountId} IS NOT NULL
  AND ${costEntries.amountUsd} IS NULL THEN coalesce(${costEntries.accountAmountUsd}, 0) ELSE 0 END)`;

/** U11 (3): a transfer's realised exchange difference, + = gain (0 while the to-side has no dollars). */
export const transferFxUsd: SQL = sql`(CASE WHEN ${accountTransfers.amountToUsd} IS NOT NULL
  THEN ${accountTransfers.amountToUsd} - ${accountTransfers.amountUsd} ELSE 0 END)`;

/** The dollars a transfer brought INTO its to-kassa: the to-side when known, else the from-side. */
export const transferInUsd: SQL = sql`coalesce(${accountTransfers.amountToUsd}, ${accountTransfers.amountUsd}, 0)`;
