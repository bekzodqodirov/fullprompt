import { eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, receipts } from '../../platform/db/schema';
import { writeAudit } from '../../platform/audit/service';
import { isUuidShaped } from '../../platform/audit/fields';
import { logger } from '../../platform/logger';
import type { ScopedActor } from '../../platform/rbac/scope';
import { mayReadReceipt } from './read-door';

/**
 * Who may add a file to a prixod from the staff bot — «📎 Fayl qo‘shish» on
 * the seller's «Prixod keldi» message (docs/PRIXOD-XABARI.md §C.6).
 *
 * EXACTLY the web's rule, and nothing wider: the upload route already asks,
 * for a file on a prixod that exists, the receipt card's own read door
 * (`/api/files/upload` → `mayReadReceipt`). So the bot opens nothing the web
 * has not opened — it puts a button where the seller is. Two things the bot
 * adds, because its target always EXISTS and is somebody's cargo: the prixod
 * must be confirmed (a draft is the wizard's, pre-bound to an id it minted)
 * and not voided (a voided prixod is off every shelf, and a paper added to
 * it would back no customs document).
 *
 * Asked at the press AND at every file: the button stays under its message
 * for ever, and a prixod can be voided between two forwards.
 *
 * Pooled reads only — never inside a transaction (tx-pool).
 */

export type ReceiptFilesRefusal = 'not_found' | 'voided' | 'forbidden';

export interface ReceiptFilesTarget {
  id: string;
  number: string;
  warehouseId: string;
  /** Null for cargo with no owner yet (the door does not ask for one). */
  clientCode: string | null;
}

type DoorActor = ScopedActor & { warehouseIds: string[] };

export async function receiptFilesDoor(
  actor: DoorActor,
  receiptId: string,
): Promise<{ ok: true; receipt: ReceiptFilesTarget } | { ok: false; error: ReceiptFilesRefusal }> {
  if (!isUuidShaped(receiptId)) return { ok: false, error: 'not_found' };
  const [row] = await db
    .select({
      id: receipts.id,
      number: receipts.number,
      status: receipts.status,
      voidedAt: receipts.voidedAt,
      warehouseId: receipts.warehouseId,
      clientCode: clients.clientCode,
    })
    .from(receipts)
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(eq(receipts.id, receiptId));
  // A draft has no card and no number: to the bot it is not a prixod yet.
  if (!row || row.status === 'draft') return { ok: false, error: 'not_found' };
  if (row.voidedAt || row.status === 'voided') return { ok: false, error: 'voided' };
  if (!(await mayReadReceipt(actor, { id: row.id, warehouseId: row.warehouseId }))) {
    return { ok: false, error: 'forbidden' };
  }
  return {
    ok: true,
    receipt: { id: row.id, number: row.number ?? '', warehouseId: row.warehouseId, clientCode: row.clientCode },
  };
}

/**
 * The History's line for a file the bot attached. `saveAttachment` writes no
 * audit row (the web's panel never has), but a file that arrives from a
 * chat has no screen behind it: without this line nobody could say who put
 * an invoice on the prixod, or when. One row per file; the History's own
 * grouping folds a burst from one person into one entry.
 *
 * Never throws: the file IS stored, and a History that cannot be written
 * must not tell the seller it was not.
 */
export async function recordReceiptFile(input: {
  actorId: string;
  receipt: Pick<ReceiptFilesTarget, 'id' | 'warehouseId'>;
  fileName: string;
}): Promise<void> {
  try {
    await writeAudit(
      db,
      { actorId: input.actorId, warehouseId: input.receipt.warehouseId },
      {
        entityType: 'receipt',
        entityId: input.receipt.id,
        action: 'update',
        before: null,
        after: { fileAdded: `${input.fileName.slice(0, 200)} · Telegram` },
      },
    );
  } catch (err) {
    logger.warn({ err, receiptId: input.receipt.id }, '[receipt-files] file not audited');
  }
}
