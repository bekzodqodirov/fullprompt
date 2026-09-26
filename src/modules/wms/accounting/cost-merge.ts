import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../../platform/db/client';
import { costEntries, expenses } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { tashkentDayStart } from '../../platform/time/tashkent';
import { fxResidueAllowance } from '../finance/money-bounds';
import { unplacedCostSince } from '../costing/service';

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
 *
 * A merge made by mistake is UNDONE, never worked around (owner's Q8, the
 * lead's A, 2026-09-25): `unmergeDuplicate` is its exact inverse — the
 * expense comes back, the cost returns to the queue, the drawer does not
 * move by a cent. Until then nothing may void a merged cost or move the
 * kassa the merge put on it (`voidCostEntryInTx`, `setCostAccount`), because
 * the cost is the only surviving record of that money.
 */

export class MergeError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export const MERGE_DAYS = 14;

/**
 * The merge's own stamp on the expense it retires — ONE home, because the
 * un-merge must tell the merge's void from a person's (a void that raced the
 * merge is a decision about money, and un-merging must never silently
 * un-void it).
 */
export const MERGE_VOID_PREFIX = 'takror → ';

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

/**
 * The M4a arithmetic, pure: null = the same money, else the reason word.
 * `window: false` skips ONLY the day check, for an expense an un-merge
 * restored: the promised round trip (un-merge, void the cost, re-enter it on
 * the right truck, merge again) happens weeks later, and refusing it then
 * invited «Saqlash» into the kassa the restored expense already debits — a
 * double debit. The money rule stays whole.
 */
export function sameMoney(
  costs: MergeCost[],
  expense: MergeExpense,
  opts: { window?: boolean } = {},
): string | null {
  if (costs.length === 0) return 'no_costs';
  const days = (a: string, b: string) =>
    Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86_400_000;
  if (opts.window !== false && costs.some((cost) => days(cost.costDate, expense.expenseDate) > MERGE_DAYS)) {
    return 'too_far_apart';
  }
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

/**
 * The same shares in DOLLARS (0103, the owner's Q13/Q18): the expense's own
 * frozen dollars ARE the payment, so the costs' kassa dollars add up to them
 * to the cent — the last share takes the remainder, clamped at zero for the
 * absurd case where rounding the others overshot a one-cent expense.
 */
export function apportionUsd(shares: number[], expense: { amount: number; amountUsd: number }): number[] {
  const out: number[] = [];
  let left = cents(expense.amountUsd);
  shares.forEach((share, index) => {
    if (index === shares.length - 1) {
      out.push(Math.max(0, cents(left)));
      return;
    }
    const usd = expense.amount > 0 ? Math.max(0, cents((expense.amountUsd * share) / expense.amount)) : 0;
    out.push(usd);
    left -= usd;
  });
  return out;
}

/**
 * The expense fences, as SQL over `expenses` (shared by the list and the
 * claim). A BOOK entry (a non-cash kind — depreciation) is never «the same
 * money typed twice» (M4a): it names no kassa, so it looked exactly like a
 * kassa-less expense, and absorbing it voided it out of the P&L (review of
 * the lead's merge).
 */
function mergeableExpenseSql() {
  return and(
    isNull(expenses.voidedAt),
    isNull(expenses.partnerId),
    isNull(expenses.recurringId),
    sql`NOT EXISTS (SELECT 1 FROM calc_offers o WHERE o.payout_expense_id = ${expenses}.id)`,
    sql`EXISTS (SELECT 1 FROM expense_categories mc WHERE mc.id = ${expenses}.category_id AND mc.cash)`,
  )!;
}

/**
 * «An un-merge restored this expense» — read off the audit row the un-merge
 * writes, so no column says it twice. `${expenses}` the table (#128), on the
 * audit's (entity_type, entity_id) index.
 */
function restoredSql() {
  return sql`EXISTS (SELECT 1 FROM audit_log a
                      WHERE a.entity_type = 'expense' AND a.entity_id = ${expenses}.id
                        AND a.after->>'unmerged' = 'true')`;
}

/**
 * Expenses a merge may absorb near these days — the picker's list. Bounded:
 * the window of the costs on screen, 14 days either side, newest first —
 * and, whatever its date, a live expense an un-merge restored (`restored`),
 * or the round trip past the window could never close.
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
      restored: sql<boolean>`${restoredSql()}`,
    })
    .from(expenses)
    .where(
      and(
        mergeableExpenseSql(),
        sql`(${expenses.expenseDate} BETWEEN ${fromDay}::date - ${MERGE_DAYS}::int AND ${toDay}::date + ${MERGE_DAYS}::int
             OR ${restoredSql()})`,
      ),
    )
    .orderBy(sql`${expenses.expenseDate} DESC`)
    .limit(limit);
}

/** The same question on the merge's own transaction — the server decides, not the browser. */
async function restoredTx(tx: Tx, expenseId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT 1 FROM audit_log a
     WHERE a.entity_type = 'expense' AND a.entity_id = ${expenseId}::uuid AND a.after->>'unmerged' = 'true'
     LIMIT 1`)) as unknown as unknown[];
  return [...rows].length > 0;
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
    const refusal = sameMoney(costs, money, { window: !(await restoredTx(tx, expense.id)) });
    if (refusal) throw new MergeError(refusal);

    const reason = `${MERGE_VOID_PREFIX}xarajat(lar): ${costs.length} ta`;
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
    // The payment's dollars (0103): the expense's own, split like the native
    // shares. Read from the LOCKED expense row only — nothing on the pool (#714).
    const usdShares = expense.accountId ? apportionUsd(shares as number[], money) : costs.map(() => null);
    for (const [index, cost] of costs.entries()) {
      const share = shares[index] ?? null;
      const usdShare = usdShares[index] ?? null;
      await tx
        .update(costEntries)
        .set({
          // An expense with no kassa leaves the costs kassa-less — the merge
          // still removes the double. One typed since kassas were asked for
          // keeps them on the queue, where a kassa or a colleague can still
          // be named; an older one is history (`unplacedCostSql`, U02).
          accountId: expense.accountId,
          accountAmount: expense.accountId && share !== null ? String(share) : null,
          accountAmountUsd: expense.accountId && usdShare !== null ? String(usdShare) : null,
          accountRateUsed: expense.accountId && usdShare !== null ? expense.rateToUsd : null,
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

/**
 * Undo a merge (owner's Q8, the lead's A): the EXACT inverse of
 * `mergeDuplicate`, keyed by the expense so 1:1 and N:1 are the same code — a
 * single cost out of an N:1 merge cannot come back alone, because the expense
 * is one amount; the accountant un-merges all of them and merges the rest
 * again. One transaction: both sides locked, the merge's shape re-checked on
 * the locked rows, the expense un-voided, and on the costs exactly what the
 * merge wrote cleared — the kassa it moved (with its dollars, F1) and the
 * link. The drawer reads the same money on the same day before and after
 * (`costCashDay`, U07): the expense debits the kassa the costs did.
 *
 * Refused (`merge_changed`) when anything moved after the merge: a cost
 * voided or re-pointed, the shares no longer adding up to a kassa expense, or
 * the expense's void not being the merge's own stamp. A merge into a
 * kassa-LESS expense is the exception the queue makes: the kassa the queue
 * placed since is cleared with the link (below), and a colleague named as the
 * payer is refused as `merge_staff_paid` — cancel their debt first.
 *
 * The rasxod xabari and the upsale are untouched: the merge never re-opened
 * them, and `mergeableExpenseSql` never let a recurring or payout expense in.
 * No recompute: allocations never depended on the kassa.
 */
export async function unmergeDuplicate(
  expenseId: string,
  ctx: AuditContext,
): Promise<{ expenseId: string; costIds: string[]; costDates: string[]; queued: number }> {
  if (!ctx.actorId) throw new MergeError('unauthenticated');
  // The queue's start day, on the pool BEFORE the transaction (#714).
  const since = await unplacedCostSince();
  return db.transaction(async (tx) => {
    const [expense] = await tx.select().from(expenses).where(eq(expenses.id, expenseId)).for('update');
    if (!expense) throw new MergeError('not_found');
    const rows = await tx
      .select()
      .from(costEntries)
      .where(eq(costEntries.mergedExpenseId, expenseId))
      .orderBy(costEntries.createdAt)
      .for('update');
    if (rows.length === 0 || expense.voidedAt === null) throw new MergeError('not_merged');
    if (!expense.voidReason?.startsWith(MERGE_VOID_PREFIX)) throw new MergeError('merge_changed');
    // Merged into a KASSA-LESS expense, the cost stayed on the queue (U02) and
    // the queue may since have answered it: a kassa placed there is not the
    // merge's, and the un-merge clears it with the link — the cost goes back
    // to the queue to be answered again, which is what «undo» promises.
    // Refusing it (as the first version did) left a wrong kassa or a mistaken
    // merge with no door at all: the void, the move and the queue all refuse
    // a merged cost (review of the lead's and comp's units). A colleague named
    // as the payer is a live DEBT on their staff account; that is cancelled
    // there first, and said so in words.
    const kassaLess = expense.accountId === null;
    if (kassaLess && rows.some((row) => row.partnerId !== null)) throw new MergeError('merge_staff_paid');
    const kassaSide = cents(rows.reduce((sum, row) => sum + Number(row.accountAmount ?? 0), 0));
    const changed =
      rows.some((row) => row.voidedAt !== null || row.partnerId !== null) ||
      (!kassaLess &&
        (rows.some((row) => row.accountId !== expense.accountId) || kassaSide !== cents(Number(expense.amount))));
    if (changed) throw new MergeError('merge_changed');

    await tx
      .update(expenses)
      .set({ voidedAt: null, voidedBy: null, voidReason: null })
      .where(and(eq(expenses.id, expenseId), isNotNull(expenses.voidedAt)));
    await writeAudit(tx, ctx, {
      entityType: 'expense',
      entityId: expenseId,
      action: 'update',
      before: { voidedAt: expense.voidedAt, voidReason: expense.voidReason },
      // `unmerged: true` is what `restoredSql` reads — the round trip's key.
      after: { unmerged: true, costIds: rows.map((row) => row.id) },
    });
    for (const row of rows) {
      await tx
        .update(costEntries)
        .set({
          accountId: null,
          accountAmount: null,
          accountAmountUsd: null,
          accountRateUsed: null,
          mergedExpenseId: null,
          updatedAt: new Date(),
        })
        .where(and(eq(costEntries.id, row.id), eq(costEntries.mergedExpenseId, expenseId)));
      await writeAudit(tx, ctx, {
        entityType: 'cost_entry',
        entityId: row.id,
        action: 'update',
        before: { accountId: row.accountId, accountAmount: row.accountAmount, mergedExpenseId: expenseId },
        after: { accountId: null, accountAmount: null, unmergedFrom: expenseId },
      });
    }
    // Which costs the queue takes back: those typed since kassas were asked
    // for — an older one is history inside a counted opening (`unplacedCostSql`).
    const start = since ? tashkentDayStart(since).getTime() : -Infinity;
    return {
      expenseId,
      costIds: rows.map((row) => row.id),
      costDates: [...new Set(rows.map((row) => row.costDate))].sort(),
      queued: rows.filter((row) => row.createdAt.getTime() >= start).length,
    };
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
