import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import { boxes, boxMovements, receiptLots, receipts, warehouses } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';
import { landedStatusFor } from '../warehouses/landed';

export class BoxStatusError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export const setBoxStatusSchema = z.object({
  boxId: z.string().uuid(),
  /** `in_stock` = "found" — a lost box recovered by a manager (owner's answer Q3). */
  to: z.enum(['lost', 'void', 'in_stock']),
  reason: z.string().trim().min(3).max(500),
});
export type SetBoxStatusInput = z.infer<typeof setBoxStatusSchema>;

/**
 * Manager-only box status flows (spec 5.5, edge case 11): in_stock → lost/void
 * with a mandatory reason; lost → in_stock when found. Boxes in an active
 * crate must be un-crated (dissolve) first so crate contents stay truthful.
 *
 * The RESTORE half is the undo for every write-off in the system — the
 * stocktake's tick-list, the receipt card's fold and the bin scan all reach
 * `lost` and this is the one door back. The corrections round's review found
 * it shipping three ways to lie:
 *
 *  - it landed a blanket `in_stock`, so a Tashkent carton restored at a
 *    warehouse that issues to clients never reached any «tayyor» list and the
 *    customer's cabinet read «O'zbekistonda» for ever;
 *  - it asked nothing about the RECEIPT, so a box lost before its receipt was
 *    voided came back as live, plannable, sellable stock hanging off a prixod
 *    that officially never happened (#723's shape, one door over);
 *  - it left `current_batch_id` pointing at whatever truck the box was on
 *    when it went missing.
 */
export async function setBoxStatus(input: SetBoxStatusInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new BoxStatusError('unauthenticated');
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(boxes).where(eq(boxes.id, input.boxId)).for('update');
    const box = rows[0];
    if (!box) throw new BoxStatusError('box_not_found');

    const allowed =
      (input.to !== 'in_stock' && box.status === 'in_stock') ||
      (input.to === 'in_stock' && box.status === 'lost');
    if (!allowed) throw new BoxStatusError('transition_not_allowed');
    if (box.crateId && input.to !== 'in_stock') throw new BoxStatusError('box_in_crate');

    // A restored box lands by the warehouse's own rule, and only onto a
    // receipt that still stands.
    let restoredStatus: 'in_stock' | 'ready_for_pickup' = 'in_stock';
    if (input.to === 'in_stock') {
      if (!box.currentWarehouseId) throw new BoxStatusError('box_has_no_warehouse');
      const [home] = await tx
        .select({ type: warehouses.type })
        .from(warehouses)
        .where(eq(warehouses.id, box.currentWarehouseId));
      if (!home) throw new BoxStatusError('box_has_no_warehouse');
      restoredStatus = landedStatusFor(home.type);

      const [parent] = await tx
        .select({ status: receipts.status, voidedAt: receipts.voidedAt, warehouseId: receipts.warehouseId })
        .from(receiptLots)
        .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
        .where(eq(receiptLots.id, box.lotId));
      if (!parent) throw new BoxStatusError('box_not_found');
      // Restoring onto a voided prixod would mint stock the cost engine has
      // already stopped pricing — refused with a reason a person can act on,
      // never a silent success.
      if (parent.voidedAt || parent.status !== 'confirmed') {
        throw new BoxStatusError('receipt_voided');
      }
    }

    await tx
      .update(boxes)
      .set({
        status: input.to === 'in_stock' ? restoredStatus : input.to,
        statusReason: input.to === 'in_stock' ? null : input.reason,
        // The truck it was on when it vanished is over. Leaving the pointer
        // would put a live box back onto a batch's live membership.
        ...(input.to === 'in_stock' ? { currentBatchId: null, flags: [] } : {}),
      })
      .where(eq(boxes.id, input.boxId));
    await tx.insert(boxMovements).values({
      boxId: box.id,
      fromWarehouseId: box.currentWarehouseId,
      toWarehouseId: box.currentWarehouseId,
      fromStatus: box.status,
      toStatus: input.to === 'in_stock' ? restoredStatus : input.to,
      cause: input.to === 'in_stock' ? 'found' : `marked_${input.to}`,
      refType: 'manual',
      actorId: ctx.actorId,
    });
    await writeAudit(tx, { ...ctx, warehouseId: box.currentWarehouseId }, {
      entityType: 'box',
      entityId: box.id,
      action: 'status_change',
      before: { status: box.status, statusReason: box.statusReason },
      after: { status: input.to === 'in_stock' ? restoredStatus : input.to, reason: input.reason },
    });
    await emitEvent(tx, {
      type: 'BoxStatusChanged',
      payload: {
        boxId: box.id,
        shortCode: box.shortCode,
        from: box.status,
        to: input.to === 'in_stock' ? restoredStatus : input.to,
        reason: input.reason,
      },
      entityType: 'box',
      entityId: box.id,
      actorId: ctx.actorId,
    });
    return { from: box.status, to: input.to === 'in_stock' ? restoredStatus : input.to };
  });
}
