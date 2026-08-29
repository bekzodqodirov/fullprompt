import { inArray } from 'drizzle-orm';
import type { Tx } from '../../platform/db/client';
import { boxes, boxMovements } from '../../platform/db/schema';

export interface VoidableBoxRow {
  id: string;
  status: string;
  statusReason: string | null;
}

/**
 * The ONE writer of the box `void` terminal state (#513): status, reason, the
 * cleared pointers and the movement row, written the same way whether the door
 * was voidReceipt (shelf boxes only) or the super-admin annul (everything).
 *
 * A `lost` box KEEPS its written loss reason — the person's sentence about a
 * crushed carton is the record box-state.ts protects, and the movement row
 * (fromStatus 'lost') already says the annul walked over it. crateId and
 * currentBatchId go with the void: a crate holding a voided member could
 * neither be dissolved nor scanned again, and a void box still pointing at a
 * batch rides `batchMemberFilter` for ever with nothing left to clear it.
 */
export async function voidBoxRows(
  tx: Tx,
  rows: VoidableBoxRow[],
  opts: { reasonText: string; refId: string; actorId: string | null },
): Promise<number> {
  if (rows.length === 0) return 0;
  const keepReason = rows.filter((b) => b.status === 'lost' && b.statusReason);
  const rewrite = rows.filter((b) => !(b.status === 'lost' && b.statusReason));
  if (rewrite.length) {
    await tx
      .update(boxes)
      .set({
        status: 'void',
        statusReason: opts.reasonText,
        crateId: null,
        currentBatchId: null,
        flags: [],
      })
      .where(inArray(boxes.id, rewrite.map((b) => b.id)));
  }
  if (keepReason.length) {
    await tx
      .update(boxes)
      .set({ status: 'void', crateId: null, currentBatchId: null, flags: [] })
      .where(inArray(boxes.id, keepReason.map((b) => b.id)));
  }
  await tx.insert(boxMovements).values(
    rows.map((b) => ({
      boxId: b.id,
      fromStatus: b.status,
      toStatus: 'void',
      cause: 'receipt_void',
      refType: 'receipt',
      refId: opts.refId,
      actorId: opts.actorId,
    })),
  );
  return rows.length;
}
