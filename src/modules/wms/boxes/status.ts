import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import { boxes, boxMovements } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';

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

    await tx
      .update(boxes)
      .set({ status: input.to, statusReason: input.to === 'in_stock' ? null : input.reason })
      .where(eq(boxes.id, input.boxId));
    await tx.insert(boxMovements).values({
      boxId: box.id,
      fromWarehouseId: box.currentWarehouseId,
      toWarehouseId: box.currentWarehouseId,
      fromStatus: box.status,
      toStatus: input.to,
      cause: input.to === 'in_stock' ? 'found' : `marked_${input.to}`,
      refType: 'manual',
      actorId: ctx.actorId,
    });
    await writeAudit(tx, { ...ctx, warehouseId: box.currentWarehouseId }, {
      entityType: 'box',
      entityId: box.id,
      action: 'status_change',
      before: { status: box.status, statusReason: box.statusReason },
      after: { status: input.to, reason: input.reason },
    });
    await emitEvent(tx, {
      type: 'BoxStatusChanged',
      payload: { boxId: box.id, shortCode: box.shortCode, from: box.status, to: input.to, reason: input.reason },
      entityType: 'box',
      entityId: box.id,
      actorId: ctx.actorId,
    });
    return { from: box.status, to: input.to };
  });
}
