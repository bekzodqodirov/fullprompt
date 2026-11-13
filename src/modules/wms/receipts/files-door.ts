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

/**
 * May a reader who has OPENED this prixod add a file to it? The ONE rule for
 * both doors (the owner's «4 b» of 2026-11-12, docs/PRIXOD-JAVOBLAR.md §3):
 * the bot's «📎 Fayl qo‘shish» and the card's «Fayllar» tile. A confirmed
 * prixod that is not voided — a draft is the wizard's, and a voided one is
 * off every shelf, its papers backing nothing. Pure: the caller has already
 * passed the read door (`mayReadReceipt`) — the card to render at all, the
 * bot below.
 */
export function mayAttachReceiptFile(receipt: { status: string; voidedAt: Date | null }): boolean {
  return receipt.status === 'confirmed' && receipt.voidedAt === null;
}

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
  // …and the card's own rule, so the two doors cannot drift (any other status
  // a prixod may grow is no prixod to add papers to, on either).
  if (!mayAttachReceiptFile(row)) return { ok: false, error: 'not_found' };
  return {
    ok: true,
    receipt: { id: row.id, number: row.number ?? '', warehouseId: row.warehouseId, clientCode: row.clientCode },
  };
}

/**
 * The History's line for a file added to a confirmed prixod — from the bot
 * («📎 Fayl qo‘shish») or, since the owner's «4 b» of 2026-11-12, on the SITE
 * (`/api/files/upload`): 5a's ⭐ told him a file «kartada va tarixda
 * ko'rinadi», and only the bot's ever did. `saveAttachment` writes no audit
 * row, so without this line nobody could say who put an invoice on the
 * prixod, or when. One row per file, each under its own key, so the
 * History's grouping folds a burst from one person into one entry that still
 * names every file. Action `update`, never `create`: `staffActivity` counts a
 * receipt's `create` rows as receipts MADE.
 *
 * Never throws: the file IS stored, and a History that cannot be written
 * must not tell the seller it was not.
 */
export async function recordReceiptFile(input: {
  actorId: string;
  receipt: Pick<ReceiptFilesTarget, 'id' | 'warehouseId'>;
  /**
   * What tells this file from the next one in the same burst — its Telegram
   * message for the bot, the attachment's own id for the site.
   */
  item: string;
  fileName: string;
  /** Where it came from: the bot's line says «· Telegram», the site's says nothing more. */
  via?: 'telegram' | 'site';
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
        // A per-file key (`fileAdded:<message>`): the History nets a run of
        // one person's edits PER KEY, so a shared key folded an album of
        // three into one line naming the last (audit/fields.ts's own rule).
        after: {
          [`fileAdded:${input.item}`]:
            (input.via ?? 'telegram') === 'telegram' ? `${input.fileName.slice(0, 200)} · Telegram` : input.fileName.slice(0, 200),
        },
      },
    );
  } catch (err) {
    logger.warn({ err, receiptId: input.receipt.id }, '[receipt-files] file not audited');
  }
}
