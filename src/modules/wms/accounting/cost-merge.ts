import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { costEntries, expenses } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { fxResidueAllowance } from '../finance/money-bounds';

/**
 * «Xarajatlarda takror» — the owner's 3b, merged away (0101, A3 + M4a).
 *
 * The accountant used to re-enter a cargo cost the warehouse had already
 * typed, as an EXPENSE with a kassa, because the cost could not say which
 * kassa paid it. The drawer was right and every report that sums both — the
 * P&L, the cash flow — counted the money twice. Both shapes exist (A3): one
 * expense per cost, and one expense summing several.
 *
 * A merge keeps the COST (it is what the tannarx, the allocations and the
 * truck's profit are built on) and retires the EXPENSE, moving its kassa onto
 * the cost(s). So the drawer does not move by a cent, the P&L falls by
 * exactly the double, and nothing a client pays for changes.
 *
 * The owner's rule for «the same money» (M4a):
 * - same currency: the costs add up to the expense TO THE CENT;
 * - different currency: within 2 % or $5 of each other in dollars, whichever
 *   is looser — the rates of two days, not a different payment.
 * and, beside it, three fences the design judge asked for: the expense is
 * nobody's debt (a partner-paid expense is a debt, not cash), not a recurring
 * posting (rent is not cargo) and not an upsale payout; and it was spent
 * within 14 days of every cost it absorbs.
 */

export class MergeError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export const MERGE_DAYS = 14;

const cents = (value: number) => Math.round(value * 100) / 100;

export interface MergeCost {
  id: string;
  amount: number;
  currency: string;
  amountUsd: number | null;
  costDate: string;
}
export interface MergeExpense {
  amount: number;
  currency: string;
  amountUsd: number;
  expenseDate: string;
}

/** The M4a arithmetic, pure: null = the same money, else the reason word. */
export function sameMoney(costs: MergeCost[], expense: MergeExpense): string | null {
  if (costs.length === 0) return 'no_costs';
  const days = (a: string, b: string) =>
    Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86_400_000;
  if (costs.some((cost) => days(cost.costDate, expense.expenseDate) > MERGE_DAYS)) return 'too_far_apart';
  if (costs.every((cost) => cost.currency === expense.currency)) {
    const total = cents(costs.reduce((sum, cost) => sum + cost.amount, 0));
    return Math.abs(total - cents(expense.amount)) < 0.005 ? null : 'amount_differs';
  }
  if (costs.some((cost) => cost.amountUsd === null)) return 'no_rate';
  const usd = costs.reduce((sum, cost) => sum + (cost.amountUsd ?? 0), 0);
  const allowed = fxResidueAllowance(expense.amountUsd);
  return Math.abs(usd - expense.amountUsd) <= allowed + 0.005 ? null : 'amount_differs';
}

/**
 * What left the kassa, per cost, in the KASSA's (= the expense's) currency.
 * The same currency: each cost's own amount (they add up to the expense by
 * the rule above). Another: the expense split by the costs' dollar shares,
 * the last taking the remainder — so the drawer's total is the expense's to
 * the cent, which is the whole point of the merge.
 */
export function apportion(costs: MergeCost[], expense: MergeExpense): number[] {
  if (costs.every((cost) => cost.currency === expense.currency)) return costs.map((cost) => cents(cost.amount));
  const totalUsd = costs.reduce((sum, cost) => sum + (cost.amountUsd ?? 0), 0);
  const out: number[] = [];
  let left = cents(expense.amount);
  costs.forEach((cost, index) => {
    if (index === costs.length - 1) {
      out.push(cents(left));
      return;
    }
    const share = totalUsd > 0 ? cents((expense.amount * (cost.amountUsd ?? 0)) / totalUsd) : 0;
    out.push(share);
    left -= share;
  });
  return out;
}

/** The expense fences, as SQL over `expenses` (shared by the list and the claim). */
function mergeableExpenseSql() {
  return and(
    isNull(expenses.voidedAt),
    isNull(expenses.partnerId),
    isNull(expenses.recurringId),
    sql`NOT EXISTS (SELECT 1 FROM calc_offers o WHERE o.payout_expense_id = ${expenses}.id)`,
  )!;
}

/**
 * Expenses a merge may absorb near these days — the picker's list. Bounded:
 * the window of the costs on screen, 14 days either side, newest first.
 */
export async function mergeCandidates(fromDay: string, toDay: string, limit = 200) {
  return db
    .select({
      id: expenses.id,
      amount: expenses.amount,
      currency: expenses.currency,
      amountUsd: expenses.amountUsd,
      expenseDate: expenses.expenseDate,
      note: expenses.note,
      accountId: expenses.accountId,
    })
    .from(expenses)
    .where(
      and(
        mergeableExpenseSql(),
        sql`${expenses.expenseDate} BETWEEN ${fromDay}::date - ${MERGE_DAYS}::int AND ${toDay}::date + ${MERGE_DAYS}::int`,
      ),
    )
    .orderBy(sql`${expenses.expenseDate} DESC`)
    .limit(limit);
}

/**
 * Retire an expense that repeats these costs, in ONE transaction: both sides
 * locked, every guard re-checked on the locked rows (a stale screen must not
 * merge money somebody has since voided or placed), the expense voided
 * WITHOUT re-opening its rasxod xabari or its upsale (it was not taken back —
 * it was the same money twice), and the kassa moved onto the costs.
 */
export async function mergeDuplicate(input: { costIds: string[]; expenseId: string }, ctx: AuditContext) {
  if (!ctx.actorId) throw new MergeError('unauthenticated');
  const costIds = [...new Set(input.costIds)];
  if (costIds.length === 0 || costIds.length > 50) throw new MergeError('no_costs');

  return db.transaction(async (tx) => {
    const [expense] = await tx
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, input.expenseId), mergeableExpenseSql()))
      .for('update');
    if (!expense) throw new MergeError('not_candidate');
    const rows = await tx
      .select()
      .from(costEntries)
      .where(
        and(
          inArray(costEntries.id, costIds),
          isNull(costEntries.voidedAt),
          isNull(costEntries.partnerId),
          isNull(costEntries.accountId),
          isNull(costEntries.mergedExpenseId),
        ),
      )
      .orderBy(costEntries.createdAt)
      .for('update');
    if (rows.length !== costIds.length) throw new MergeError('cost_taken');

    const costs: MergeCost[] = rows.map((row) => ({
      id: row.id,
      amount: Number(row.amount),
      currency: row.currency,
      amountUsd: row.amountUsd === null ? null : Number(row.amountUsd),
      costDate: row.costDate,
    }));
    const money: MergeExpense = {
      amount: Number(expense.amount),
      currency: expense.currency,
      amountUsd: Number(expense.amountUsd),
      expenseDate: expense.expenseDate,
    };
    const refusal = sameMoney(costs, money);
    if (refusal) throw new MergeError(refusal);

    const reason = `takror → xarajat(lar): ${costs.length} ta`;
    await tx
      .update(expenses)
      .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason })
      .where(eq(expenses.id, expense.id));
    await writeAudit(tx, ctx, {
      entityType: 'expense',
      entityId: expense.id,
      action: 'void',
      before: { amountUsd: expense.amountUsd, accountId: expense.accountId },
      after: { reason, mergedInto: costs.map((cost) => cost.id) },
    });

    const shares = expense.accountId ? apportion(costs, money) : costs.map(() => null);
    for (const [index, cost] of costs.entries()) {
      const share = shares[index] ?? null;
      await tx
        .update(costEntries)
        .set({
          // An expense with no kassa leaves the costs kassa-less — the merge
          // still removes the double. One typed since kassas were asked for
          // keeps them on the queue, where a kassa or a colleague can still
          // be named; an older one is history (`unplacedCostSql`, U02).
          accountId: expense.accountId,
          accountAmount: expense.accountId && share !== null ? String(share) : null,
          mergedExpenseId: expense.id,
          updatedAt: new Date(),
        })
        .where(eq(costEntries.id, cost.id));
      await writeAudit(tx, ctx, {
        entityType: 'cost_entry',
        entityId: cost.id,
        action: 'update',
        before: { accountId: null },
        after: { accountId: expense.accountId, accountAmount: share, fromExpense: expense.id },
      });
    }
    return { expenseId: expense.id, costIds: costs.map((cost) => cost.id) };
  });
}

/** The last merges, for the queue screen's «Birlashtirilganlar» list. */
export async function recentMerges(limit = 30) {
  return db
    .select({
      expenseId: expenses.id,
      amount: expenses.amount,
      currency: expenses.currency,
      expenseDate: expenses.expenseDate,
      note: expenses.note,
      voidedAt: expenses.voidedAt,
      costs: sql<number>`(SELECT count(*)::int FROM cost_entries ce WHERE ce.merged_expense_id = ${expenses}.id)`,
    })
    .from(expenses)
    .where(sql`EXISTS (SELECT 1 FROM cost_entries ce WHERE ce.merged_expense_id = ${expenses}.id)`)
    .orderBy(sql`${expenses.voidedAt} DESC`)
    .limit(limit);
}
