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
import { clientBalanceUsd, deferredBalanceUsd } from '../finance/service';
import { lockLiveApproval, markApprovalConsumed } from './approvals';

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
  /** Debt gate override (Phase 2.1): a permitted manager allows issuing to a debtor. */
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
  // Debt gate (Phase 2.1, owner's rule): a debtor gets cargo only with a
  // manager's permission — debtOk is that permission, checked in the action
  // layer against finance.debt_override.
  // Money the client agreed to pay LATER, on a job that is still waiting for
  // its last box, is not overdue (docs/DEALS.md answer 4). The client's
  // displayed balance stays honest — only the figure the GATE reads is
  // reduced, and only by charges raised on a deal that is deferred right now.
  const balance = await clientBalanceUsd(input.clientId);
  const deferred = await deferredBalanceUsd(input.clientId);
  const blockingDebt = Math.round((balance - deferred) * 100) / 100;
  return db.transaction(async (tx) => {
    const existing = await tx.query.handovers.findFirst({
      where: eq(handovers.id, input.handoverId),
    });
    if (existing) return existing;

    // Phase 6: an operator without the override may still issue when a
    // RECORDED approval covers this client at this warehouse — live,
    // unexpired, and at least as large as today's debt. Locked here (FOR
    // UPDATE, so two phones cannot spend one permission) and marked consumed
    // once the handover row exists; one transaction makes the pair atomic.
    let approvalId: string | null = null;
    if (blockingDebt > 0.009 && !input.debtOk) {
      approvalId = await lockLiveApproval(tx, {
        clientId: input.clientId,
        warehouseId: input.warehouseId,
        blockingDebtUsd: blockingDebt,
      });
      if (!approvalId) throw new IssueError('debt_block');
    }

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

    if (approvalId) await markApprovalConsumed(tx, approvalId, handover!.id);

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
        // Both halves of a debtor issue are in the log: the decision on the
        // approval row, and here WHICH approval this handover spent.
        ...(approvalId ? { approvalId } : {}),
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
