import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { costEntries, expenses, partnerTransactions } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';

/**
 * The bridge between a COST and a DEBT — the two facts this round keeps
 * apart on purpose.
 *
 * A truck taken on credit is one event with two consequences: the cargo it
 * carried gets dearer (tannarx, `cost_entries` → `cost_allocations`, which
 * already worked) and we owe the transport company (`partner_transactions`,
 * which did not exist). Entering it twice by hand is how the two drift apart;
 * entering it once and deriving the second is how they cannot.
 *
 * Deriving, not duplicating: the charge row POINTS at the cost row, so the
 * P&L reads costs and the partner screen reads debts and neither counts the
 * other. Paying the partner later is a `payment` row — money moving, not a
 * second cost — so nothing is ever counted twice.
 */

/** Mirror a cost entry onto its partner's account. Idempotent per cost. */
export async function chargeForCost(costEntryId: string, ctx: AuditContext): Promise<void> {
  if (!ctx.actorId) return;
  const entry = await db.query.costEntries.findFirst({ where: eq(costEntries.id, costEntryId) });
  if (!entry?.partnerId) return;
  // The recompute has run by now, so `amountUsd` is real; when a rate is
  // missing it is null and there is nothing honest to post yet.
  if (entry.amountUsd === null || entry.fxRateUsed === null) return;

  const [existing] = await db
    .select()
    .from(partnerTransactions)
    .where(
      and(
        eq(partnerTransactions.costEntryId, costEntryId),
        isNull(partnerTransactions.voidedAt),
      ),
    )
    .limit(1);
  if (existing) {
    // The recompute that brought us here may have RE-PRICED the cost — an FX
    // rate arriving or being corrected re-runs every entry in that currency —
    // and a charge left at the old number lets the two facts drift: the P&L
    // reads the new cost while the firm gets settled for the old one. The
    // debt follows its cost, always, or the pair rule is only half a rule.
    const drifted =
      existing.amount !== entry.amount ||
      existing.amountUsd !== entry.amountUsd ||
      existing.rateToUsd !== entry.fxRateUsed ||
      existing.currency !== entry.currency;
    if (drifted) {
      await db
        .update(partnerTransactions)
        .set({
          amount: entry.amount,
          currency: entry.currency,
          rateToUsd: entry.fxRateUsed,
          amountUsd: entry.amountUsd,
        })
        .where(eq(partnerTransactions.id, existing.id));
      await writeAudit(db, ctx, {
        entityType: 'partner_transaction',
        entityId: existing.id,
        action: 'update',
        before: { amount: existing.amount, currency: existing.currency, amountUsd: existing.amountUsd },
        after: { amount: entry.amount, currency: entry.currency, amountUsd: entry.amountUsd, from: 'cost_entry_reprice' },
      });
    }
    return;
  }

  const [row] = await db
    .insert(partnerTransactions)
    .values({
      partnerId: entry.partnerId,
      type: 'charge',
      amount: entry.amount,
      currency: entry.currency,
      rateToUsd: entry.fxRateUsed,
      amountUsd: entry.amountUsd,
      txDate: entry.costDate,
      batchId: entry.batchId,
      costEntryId,
      note: entry.note,
      createdBy: ctx.actorId,
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'partner_transaction',
    entityId: row!.id,
    action: 'create',
    after: { from: 'cost_entry', costEntryId, partnerId: entry.partnerId },
  });
}

export async function voidChargeForCost(
  costEntryId: string,
  reason: string,
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) return;
  const rows = await db
    .update(partnerTransactions)
    .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason })
    .where(
      and(eq(partnerTransactions.costEntryId, costEntryId), isNull(partnerTransactions.voidedAt)),
    )
    .returning({ id: partnerTransactions.id });
  for (const row of rows) {
    await writeAudit(db, ctx, {
      entityType: 'partner_transaction',
      entityId: row.id,
      action: 'void',
      after: { reason, from: 'cost_entry', costEntryId },
    });
  }
}

/** The same bridge for an overhead somebody else paid (rent, salaries). */
export async function chargeForExpense(expenseId: string, ctx: AuditContext): Promise<void> {
  if (!ctx.actorId) return;
  const row = await db.query.expenses.findFirst({ where: eq(expenses.id, expenseId) });
  if (!row?.partnerId) return;

  const existing = await db
    .select({ id: partnerTransactions.id })
    .from(partnerTransactions)
    .where(
      and(eq(partnerTransactions.expenseId, expenseId), isNull(partnerTransactions.voidedAt)),
    )
    .limit(1);
  if (existing.length > 0) return;

  const [created] = await db
    .insert(partnerTransactions)
    .values({
      partnerId: row.partnerId,
      type: 'charge',
      amount: row.amount,
      currency: row.currency,
      rateToUsd: row.rateToUsd,
      amountUsd: row.amountUsd,
      txDate: row.expenseDate,
      expenseId,
      note: row.note,
      createdBy: ctx.actorId,
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'partner_transaction',
    entityId: created!.id,
    action: 'create',
    after: { from: 'expense', expenseId, partnerId: row.partnerId },
  });
}

export async function voidChargeForExpense(
  expenseId: string,
  reason: string,
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) return;
  const rows = await db
    .update(partnerTransactions)
    .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason })
    .where(and(eq(partnerTransactions.expenseId, expenseId), isNull(partnerTransactions.voidedAt)))
    .returning({ id: partnerTransactions.id });
  for (const row of rows) {
    await writeAudit(db, ctx, {
      entityType: 'partner_transaction',
      entityId: row.id,
      action: 'void',
      after: { reason, from: 'expense', expenseId },
    });
  }
}
