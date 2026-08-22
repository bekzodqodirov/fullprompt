import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  boxes,
  boxMovements,
  handovers,
  receiptLots,
  receipts,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';
import { splitForCorrection } from '../receipts/box-state';

export class ReturnError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export const returnToSenderSchema = z.object({
  /** Client-generated so an optional handover photo can pre-bind to it. */
  handoverId: z.string().uuid(),
  receiptId: z.string().uuid(),
  personName: z.string().trim().min(2).max(200),
  personPhone: z.string().trim().min(5).max(50),
  note: z.string().trim().max(500).optional().or(z.literal('')),
});
export type ReturnToSenderInput = z.infer<typeof returnToSenderSchema>;

/**
 * Unclaimed resolution — return to sender (spec 6.7, owner's answer Q2: whole
 * receipt at once; who-took-it name+phone mandatory, photo optional). Boxes →
 * `issued` with reason `returned_to_sender`; a handover record captures the
 * person.
 */
export async function returnUnclaimedToSender(input: ReturnToSenderInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new ReturnError('unauthenticated');
  const actorId = ctx.actorId;
  return db.transaction(async (tx) => {
    // Idempotent by client-generated handover id.
    const existing = await tx.query.handovers.findFirst({
      where: eq(handovers.id, input.handoverId),
    });
    if (existing) return existing;

    const receipt = await tx.query.receipts.findFirst({ where: eq(receipts.id, input.receiptId) });
    if (!receipt) throw new ReturnError('receipt_not_found');
    if (receipt.status !== 'confirmed') throw new ReturnError('receipt_not_confirmed');
    if (receipt.clientId !== null) throw new ReturnError('not_unclaimed');

    const lotIds = (
      await tx.select({ id: receiptLots.id }).from(receiptLots).where(eq(receiptLots.receiptId, input.receiptId))
    ).map((l) => l.id);
    const memberBoxes = await tx
      .select()
      .from(boxes)
      .where(inArray(boxes.lotId, lotIds))
      .for('update');
    // A `void` or `lost` box neither blocks the return nor goes back to the
    // sender: for unclaimed cargo this door is the ONLY exit, so blocking on
    // a carton nothing will ever move again meant the sender standing at the
    // counter could be refused for ever (receipts/box-state.ts).
    const { act, blocked } = splitForCorrection(memberBoxes);
    if (blocked.length) throw new ReturnError('box_not_in_stock');
    if (act.some((box) => box.crateId)) throw new ReturnError('box_in_crate');

    const [handover] = await tx
      .insert(handovers)
      .values({
        id: input.handoverId,
        receiptId: input.receiptId,
        warehouseId: receipt.warehouseId,
        kind: 'returned_to_sender',
        personName: input.personName,
        personPhone: input.personPhone,
        note: input.note || null,
        createdBy: actorId,
      })
      .returning();

    if (act.length) {
      await tx
        .update(boxes)
        .set({ status: 'issued', statusReason: 'returned_to_sender' })
        .where(inArray(boxes.id, act.map((b) => b.id)));
      await tx.insert(boxMovements).values(
        act.map((box) => ({
          boxId: box.id,
          fromWarehouseId: box.currentWarehouseId,
          toWarehouseId: box.currentWarehouseId,
          fromStatus: box.status,
          toStatus: 'issued',
          cause: 'returned_to_sender',
          refType: 'handover',
          refId: handover!.id,
          actorId,
        })),
      );
    }
    await writeAudit(tx, { ...ctx, warehouseId: receipt.warehouseId }, {
      entityType: 'receipt',
      entityId: input.receiptId,
      action: 'status_change',
      after: {
        resolution: 'returned_to_sender',
        personName: input.personName,
        personPhone: input.personPhone,
        boxCount: act.length,
      },
    });
    await emitEvent(tx, {
      type: 'UnclaimedReturned',
      payload: {
        receiptId: input.receiptId,
        number: receipt.number,
        marking: receipt.unclaimedMarking,
        personName: input.personName,
        boxCount: act.length,
      },
      entityType: 'receipt',
      entityId: input.receiptId,
      actorId,
    });
    return handover!;
  });
}
