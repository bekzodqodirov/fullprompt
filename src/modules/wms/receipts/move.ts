import { eq, inArray } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  boxes,
  boxMovements,
  receiptLots,
  receipts,
  warehouses,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';

export class MoveError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/**
 * Wrong-warehouse fix (edge case 15): a manager moves a WHOLE receipt to the
 * correct warehouse with correcting box movements. Allowed only while every
 * box is still in_stock and un-crated (post-departure fixes belong to the M4
 * transfer machinery). The receipt number and letters keep their original WH
 * prefix (immutable labels) — the UI prompts a label reprint after the move.
 */
export async function moveReceipt(receiptId: string, toWarehouseId: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new MoveError('unauthenticated');
  return db.transaction(async (tx) => {
    const receipt = await tx.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
    if (!receipt) throw new MoveError('receipt_not_found');
    if (receipt.status !== 'confirmed') throw new MoveError('receipt_not_confirmed');
    if (receipt.warehouseId === toWarehouseId) throw new MoveError('same_warehouse');
    const target = await tx.query.warehouses.findFirst({
      where: eq(warehouses.id, toWarehouseId),
    });
    if (!target) throw new MoveError('warehouse_not_found');

    const lotIds = (
      await tx.select({ id: receiptLots.id }).from(receiptLots).where(eq(receiptLots.receiptId, receiptId))
    ).map((l) => l.id);
    const memberBoxes = await tx
      .select()
      .from(boxes)
      .where(inArray(boxes.lotId, lotIds))
      .for('update');
    for (const box of memberBoxes) {
      if (box.status !== 'in_stock') throw new MoveError('box_not_in_stock');
      if (box.crateId) throw new MoveError('box_in_crate');
    }

    await tx.update(receipts).set({ warehouseId: toWarehouseId }).where(eq(receipts.id, receiptId));
    await tx
      .update(boxes)
      .set({ currentWarehouseId: toWarehouseId })
      .where(inArray(boxes.lotId, lotIds));
    await tx.insert(boxMovements).values(
      memberBoxes.map((box) => ({
        boxId: box.id,
        fromWarehouseId: box.currentWarehouseId,
        toWarehouseId,
        fromStatus: box.status,
        toStatus: box.status,
        cause: 'receipt_moved',
        refType: 'receipt',
        refId: receiptId,
        actorId: ctx.actorId,
      })),
    );
    await writeAudit(tx, { ...ctx, warehouseId: receipt.warehouseId }, {
      entityType: 'receipt',
      entityId: receiptId,
      action: 'update',
      before: { warehouseId: receipt.warehouseId },
      after: { warehouseId: toWarehouseId, movedBoxes: memberBoxes.length },
    });
    await emitEvent(tx, {
      type: 'ReceiptMoved',
      payload: {
        receiptId,
        number: receipt.number,
        fromWarehouseId: receipt.warehouseId,
        toWarehouseId,
        boxCount: memberBoxes.length,
      },
      entityType: 'receipt',
      entityId: receiptId,
      actorId: ctx.actorId,
    });
    return { boxCount: memberBoxes.length, toCode: target.code };
  });
}
