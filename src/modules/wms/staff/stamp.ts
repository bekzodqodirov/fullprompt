import { sql, type SQL } from 'drizzle-orm';
import type { Db, Tx } from '../../platform/db/client';
import { writeAudit, type AuditContext } from '../../platform/audit/service';

/**
 * WHOSE cargo a prixod is (0117, the owner's 1a/2a, 2026-09-29): «a seller's
 * cargo = every cargo of the clients whose card names that seller», and «a
 * client moved to another seller keeps the old cargo with whoever was the
 * seller ON THE DAY THE CARGO WAS RECEIVED».
 *
 * The client book (`clients.sales_manager_id`) says who the seller is NOW,
 * so it cannot answer the second sentence; a column on the receipt written
 * at the moment the receipt gets its client can. Two writers set
 * `receipts.client_id` — `confirmReceipt`'s INSERT (the China wizard and the
 * office door are one function) and `assignReceiptClient`'s UPDATE (the claim
 * of unclaimed cargo, and the A→B correction) — and both write the stamp in
 * the SAME statement through this fragment, so there is no window in which a
 * receipt has a client and no stamp. `tests/unit/receipt-stamp-wire.test.ts`
 * derives that every writer of the client names the stamp too (#896's shape:
 * a new writer that forgets it is a red test, not a quiet hole).
 *
 * A later change of the client's seller NEVER restamps (his 2a). The one
 * exception is «nobody»: cargo received while the client had no seller goes
 * to the first seller named afterwards (`stampUnattributedCargo`) — the same
 * sentence the migration's backfill states for history.
 */

/** The seller in force for `clientId` right now, as a scalar subquery — NULL for no client or no seller. */
export function stampFor(clientId: SQL): SQL {
  return sql`(SELECT stamp_c.sales_manager_id FROM clients stamp_c WHERE stamp_c.id = ${clientId})`;
}

/**
 * The first seller named on a client takes the client's cargo nobody was
 * named on (his «hamma mijozlarga biriktirib chiqdim»: the book was filled in
 * AFTER the cargo came). Called by every door that moves a client's seller
 * from NULL to someone — the client form and the import script's `--update`
 * (`tests/unit/manager-stamp-wire.test.ts` derives the list). Only NULL
 * stamps move, so a stamp written on a receipt day is never overwritten.
 *
 * One audit row on the CLIENT, because what changed is whose cargo that
 * client's history is — and the receipts count says how much of it.
 */
export async function stampUnattributedCargo(
  exec: Db | Tx,
  clientId: string,
  managerId: string,
  ctx: AuditContext,
): Promise<number> {
  const rows = await exec.execute<{ id: string }>(sql`
    UPDATE receipts SET sales_manager_id = ${managerId}::uuid
     WHERE client_id = ${clientId}::uuid AND sales_manager_id IS NULL
    RETURNING id`);
  const n = rows.length;
  if (n > 0) {
    await writeAudit(exec, ctx, {
      entityType: 'client',
      entityId: clientId,
      action: 'update',
      after: { cargoStampedTo: managerId, receipts: n },
    });
  }
  return n;
}

/**
 * The repair «Sotuvchisiz yuk» offers for a client whose card names a seller
 * while some of its receipts still carry none — the one race the client
 * form's stamp cannot see (unstampedCargo's `currentSellerId` says how it
 * happens), and after which no later save stamps them. It applies the
 * decision the client card ALREADY holds: the seller is read from the client
 * row here, never taken from the post, so the button can name nobody the
 * card does not. Null when the client has no seller (nothing to apply) —
 * the list then says «mijozga sotuvchi belgilang» instead.
 */
export async function stampToCurrentSeller(
  exec: Db | Tx,
  clientId: string,
  ctx: AuditContext,
): Promise<{ sellerId: string; receipts: number } | null> {
  const [client] = await exec.execute<{ sales_manager_id: string | null }>(sql`
    SELECT sales_manager_id FROM clients WHERE id = ${clientId}::uuid`);
  if (!client?.sales_manager_id) return null;
  const receipts = await stampUnattributedCargo(exec, clientId, client.sales_manager_id, ctx);
  return { sellerId: client.sales_manager_id, receipts };
}
