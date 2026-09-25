import { and, eq, isNull } from 'drizzle-orm';
import { db, type Tx } from '../../platform/db/client';
import { costEntries, expenses, partnerTransactions } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { lockOwnersTx, reconcileFxResidueTx } from '../finance/fx-residue';

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
  const partnerId = entry.partnerId;
  const actorId = ctx.actorId;

  // The firm's money lock, the claim (re-checked under it), the charge and
  // the kurs farqi reconciler in ONE commit (0103).
  await db.transaction(async (tx) => {
    await lockOwnersTx(tx, { partnerIds: [partnerId] });
    const [existing] = await tx
      .select({ id: partnerTransactions.id })
      .from(partnerTransactions)
      .where(
        and(
          eq(partnerTransactions.costEntryId, costEntryId),
          isNull(partnerTransactions.voidedAt),
        ),
      )
      .limit(1);
    // One charge per cost, frozen at birth like every other ledger row (R1).
    // This used to follow a re-priced cost, which re-priced the DEBT while the
    // payment that settled it stayed put — a fully paid firm then read a
    // balance (audit A0). The cost itself no longer moves once converted, so
    // there is nothing to follow; a mistyped cost is void and re-enter — and
    // a debt re-priced by a corrected rate moves only through the /admin/fx
    // confirm, together with its cost (Q18).
    if (existing) return;

    const [row] = await tx
      .insert(partnerTransactions)
      .values({
        partnerId,
        type: 'charge',
        amount: entry.amount,
        currency: entry.currency,
        rateToUsd: entry.fxRateUsed!,
        amountUsd: entry.amountUsd!,
        txDate: entry.costDate,
        batchId: entry.batchId,
        costEntryId,
        note: entry.note,
        createdBy: actorId,
      })
      .returning();
    await reconcileFxResidueTx(tx, { partnerIds: [partnerId] }, ctx);
    await writeAudit(tx, ctx, {
      entityType: 'partner_transaction',
      entityId: row!.id,
      action: 'create',
      after: { from: 'cost_entry', costEntryId, partnerId },
    });
  });
}

export async function voidChargeForCost(
  costEntryId: string,
  reason: string,
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) return;
  const partnerIds = (
    await db
      .select({ partnerId: partnerTransactions.partnerId })
      .from(partnerTransactions)
      .where(and(eq(partnerTransactions.costEntryId, costEntryId), isNull(partnerTransactions.voidedAt)))
  ).map((row) => row.partnerId);
  if (partnerIds.length === 0) return;
  await db.transaction(async (tx) => {
    await lockOwnersTx(tx, { partnerIds });
    const rows = await tx
      .update(partnerTransactions)
      .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason })
      .where(
        and(eq(partnerTransactions.costEntryId, costEntryId), isNull(partnerTransactions.voidedAt)),
      )
      .returning({ id: partnerTransactions.id });
    await reconcileFxResidueTx(tx, { partnerIds }, ctx);
    for (const row of rows) {
      await writeAudit(tx, ctx, {
        entityType: 'partner_transaction',
        entityId: row.id,
        action: 'void',
        after: { reason, from: 'cost_entry', costEntryId },
      });
    }
  });
}

/** The same bridge for an overhead somebody else paid (rent, salaries). */
export async function chargeForExpense(expenseId: string, ctx: AuditContext): Promise<void> {
  if (!ctx.actorId) return;
  const row = await db.query.expenses.findFirst({ where: eq(expenses.id, expenseId) });
  if (!row) return;
  // Standalone door: its own transaction — the firm's money lock and the
  // kurs farqi reconciler (0103) live in the Tx half, so both callers get them.
  await db.transaction((tx) => chargeForExpenseTx(tx, row, ctx));
}

/**
 * The WRITE half, on the caller's transaction, for the expense ROW it is
 * given — never read again. «To'landi» (accounting/recurring.ts) writes the
 * expense and the firm's debt in ONE transaction (0106, M7): after a commit,
 * a failed charge left the month closed on an expense that owed the firm
 * nothing, and the press could not be made again to repair it. The firm's
 * money lock goes before the write and the kurs farqi reconciler after it
 * (0103, fence F2): a charge can close a firm's currency.
 */
export async function chargeForExpenseTx(
  tx: Tx,
  row: typeof expenses.$inferSelect,
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId || !row.partnerId) return;
  const partnerId = row.partnerId;
  await lockOwnersTx(tx, { partnerIds: [partnerId] });

  const existing = await tx
    .select({ id: partnerTransactions.id })
    .from(partnerTransactions)
    .where(
      and(eq(partnerTransactions.expenseId, row.id), isNull(partnerTransactions.voidedAt)),
    )
    .limit(1);
  if (existing.length > 0) return;

  const [created] = await tx
    .insert(partnerTransactions)
    .values({
      partnerId,
      type: 'charge',
      amount: row.amount,
      currency: row.currency,
      rateToUsd: row.rateToUsd,
      amountUsd: row.amountUsd,
      txDate: row.expenseDate,
      expenseId: row.id,
      note: row.note,
      createdBy: ctx.actorId,
    })
    .returning();
  await reconcileFxResidueTx(tx, { partnerIds: [partnerId] }, ctx);
  await writeAudit(tx, ctx, {
    entityType: 'partner_transaction',
    entityId: created!.id,
    action: 'create',
    after: { from: 'expense', expenseId: row.id, partnerId },
  });
}

export async function voidChargeForExpense(
  expenseId: string,
  reason: string,
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) return;
  const partnerIds = (
    await db
      .select({ partnerId: partnerTransactions.partnerId })
      .from(partnerTransactions)
      .where(and(eq(partnerTransactions.expenseId, expenseId), isNull(partnerTransactions.voidedAt)))
  ).map((row) => row.partnerId);
  if (partnerIds.length === 0) return;
  await db.transaction(async (tx) => {
    await lockOwnersTx(tx, { partnerIds });
    const rows = await tx
      .update(partnerTransactions)
      .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason })
      .where(and(eq(partnerTransactions.expenseId, expenseId), isNull(partnerTransactions.voidedAt)))
      .returning({ id: partnerTransactions.id });
    await reconcileFxResidueTx(tx, { partnerIds }, ctx);
    for (const row of rows) {
      await writeAudit(tx, ctx, {
        entityType: 'partner_transaction',
        entityId: row.id,
        action: 'void',
        after: { reason, from: 'expense', expenseId },
      });
    }
  });
}
