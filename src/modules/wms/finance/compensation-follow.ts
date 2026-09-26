import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '../../platform/db/client';
import { clientTransactions } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';

/**
 * The compensation's pair rules with its prixod (0105, Q15), in a module of
 * their own with no service imports: `deals/service.ts` (`linkReceipt`) and
 * `receipts/*` (`assignReceiptClient`, `voidReceipt`, the annul) call these
 * inside their own transactions, and must not gain an import cycle through
 * the finance service.
 */

type Exec = Pick<Db, 'execute'> | Pick<Tx, 'execute'>;

/**
 * A compensation's deal FOLLOWS its prixod (the judge's money finding 1):
 * the deal is an attribution the system derived, so when `linkReceipt`
 * re-files or detaches the prixod, the compensation moves with it in the
 * same transaction — the way the cost side already reads the live
 * `receipts.deal_id`. The CLIENT never follows: that is who we owe, and
 * moving it is money (refused at `assignReceiptClient`).
 */
export async function followCompensationDealTx(
  tx: Tx,
  receiptId: string,
  dealId: string | null,
  ctx: AuditContext,
): Promise<void> {
  // The rows and their deal BEFORE, read under the prixod's row lock the
  // caller holds (its `update(receipts)` came first).
  const standing = await tx
    .select({ id: clientTransactions.id, dealId: clientTransactions.dealId })
    .from(clientTransactions)
    .where(
      and(
        eq(clientTransactions.receiptId, receiptId),
        eq(clientTransactions.type, 'compensation'),
        isNull(clientTransactions.voidedAt),
      ),
    );
  for (const row of standing) {
    if (row.dealId === dealId) continue;
    await tx.update(clientTransactions).set({ dealId }).where(eq(clientTransactions.id, row.id));
    await writeAudit(tx, ctx, {
      entityType: 'client_transaction',
      entityId: row.id,
      action: 'update',
      before: { dealId: row.dealId },
      after: { dealId, from: 'receipt_relink', receiptId },
    });
  }
}

/**
 * Does a live compensation name this prixod? The refusal at the doors that
 * would move who we owe (`assignReceiptClient`) or make the prixod not have
 * happened (`voidReceipt`, the annul) — money first (#288, #530, #852).
 */
export async function receiptHasCompensation(handle: Exec, receiptId: string): Promise<boolean> {
  const rows = (await handle.execute(sql`
    SELECT 1 FROM client_transactions
     WHERE receipt_id = ${receiptId}::uuid AND type = 'compensation' AND voided_at IS NULL
     LIMIT 1`)) as unknown as unknown[];
  return [...rows].length > 0;
}
