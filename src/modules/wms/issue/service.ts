import { and, eq, inArray, sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  boxes,
  boxMovements,
  handovers,
  receiptLots,
  receipts,
  scanEvents,
  warehouses,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';

export class IssueError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export const issueSchema = z.object({
  /** Client-generated: idempotency + photo pre-binding + act URL. */
  handoverId: z.string().uuid(),
  clientId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  boxIds: z.array(z.string().uuid()).min(1).max(500),
  personName: z.string().trim().min(2).max(200),
  personPhone: z.string().trim().min(5).max(50),
  /** Phase 3 hook — recorded, no logic (spec 6.7). */
  debtOk: z.boolean().default(false),
  note: z.string().trim().max(500).optional().or(z.literal('')),
});
export type IssueInput = z.infer<typeof issueSchema>;

/**
 * W7 issue-to-client (spec 6.7): selected boxes → `issued` with a handover
 * record; partial pickup simply leaves the rest ready_for_pickup. Idempotent
 * by handoverId.
 */
export async function issueBoxes(input: IssueInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new IssueError('unauthenticated');
  const actorId = ctx.actorId;
  return db.transaction(async (tx) => {
    const existing = await tx.query.handovers.findFirst({
      where: eq(handovers.id, input.handoverId),
    });
    if (existing) return existing;

    const rows = await tx
      .select({ box: boxes, clientId: receipts.clientId })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .where(inArray(boxes.id, input.boxIds))
      .for('update', { of: boxes });
    if (rows.length !== input.boxIds.length) throw new IssueError('box_not_found');
    for (const { box, clientId } of rows) {
      if (clientId !== input.clientId) throw new IssueError('wrong_client');
      if (!['ready_for_pickup', 'in_stock'].includes(box.status)) {
        throw new IssueError('box_not_available');
      }
      if (box.currentWarehouseId !== input.warehouseId) throw new IssueError('box_wrong_warehouse');
    }

    const [handover] = await tx
      .insert(handovers)
      .values({
        id: input.handoverId,
        clientId: input.clientId,
        warehouseId: input.warehouseId,
        kind: 'issued_to_client',
        personName: input.personName,
        personPhone: input.personPhone,
        debtOk: input.debtOk,
        note: input.note || null,
        createdBy: actorId,
      })
      .returning();

    await tx
      .update(boxes)
      .set({ status: 'issued', crateId: null, statusReason: 'issued_to_client' })
      .where(inArray(boxes.id, input.boxIds));
    await tx.insert(boxMovements).values(
      rows.map(({ box }) => ({
        boxId: box.id,
        fromWarehouseId: box.currentWarehouseId,
        toWarehouseId: box.currentWarehouseId,
        fromStatus: box.status,
        toStatus: 'issued',
        cause: 'issued',
        refType: 'handover',
        refId: handover!.id,
        actorId,
      })),
    );
    await tx.insert(scanEvents).values(
      rows.map(({ box }) => ({
        clientEventUuid: uuidv5(box.id, input.handoverId),
        boxId: box.id,
        handoverId: handover!.id,
        type: 'issue',
        method: 'manual',
        manualReason: 'issue_screen',
        scannedBy: actorId,
        scannedAt: new Date(),
      })),
    ).onConflictDoNothing();

    const wh = (await tx.query.warehouses.findFirst({
      where: eq(warehouses.id, input.warehouseId),
    }))!;
    const remainingRow = await tx
      .select({ n: sql<number>`count(*)` })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .where(
        and(
          eq(receipts.clientId, input.clientId),
          eq(boxes.currentWarehouseId, input.warehouseId),
          inArray(boxes.status, ['ready_for_pickup', 'in_stock']),
        ),
      );

    await writeAudit(tx, { ...ctx, warehouseId: input.warehouseId }, {
      entityType: 'handover',
      entityId: handover!.id,
      action: 'create',
      after: {
        clientId: input.clientId,
        boxCount: rows.length,
        personName: input.personName,
        debtOk: input.debtOk,
      },
    });
    await emitEvent(tx, {
      type: 'BoxIssued',
      payload: {
        handoverId: handover!.id,
        clientId: input.clientId,
        warehouseId: input.warehouseId,
        warehouseCode: wh.code,
        boxCount: rows.length,
        remaining: Number(remainingRow[0]!.n),
        personName: input.personName,
        personPhone: input.personPhone,
      },
      entityType: 'handover',
      entityId: handover!.id,
      actorId,
    });
    return handover!;
  });
}
