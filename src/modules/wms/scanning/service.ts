import { and, eq, inArray, sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  loadPlans,
  receiptLots,
  scanEvents,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';

export class ScanError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export const loadScanSchema = z.object({
  clientEventUuid: z.string().uuid(),
  batchId: z.string().uuid(),
  /** Box short code (`YW26-000123`) or crate code (`CR-...`). */
  code: z.string().trim().min(3).max(40),
  method: z.enum(['qr', 'manual']),
  manualReason: z.string().trim().max(200).optional().or(z.literal('')),
  /** Confirmed not-on-plan load ("load anyway" + reason). */
  addedOnSpot: z.boolean().default(false),
  addedReason: z.string().trim().max(500).optional().or(z.literal('')),
  scannedAt: z.string().datetime(),
});
export type LoadScanInput = z.infer<typeof loadScanSchema>;

export interface ScanAck {
  clientEventUuid: string;
  result: 'ok' | 'duplicate' | 'not_on_plan' | 'unknown_code' | 'rejected';
  detail?: string;
  boxes?: { shortCode: string; letter: string | null }[];
}

/**
 * W4 load-scan ingest — idempotent by clientEventUuid (offline outbox replays
 * safely, edge case 14). A crate code fans out to one row per member box with
 * derived uuid5 ids (DECISIONS/ARCHITECTURE). Not-on-plan boxes require the
 * confirmed `addedOnSpot` flag; they join the batch flagged and Telegram-alert
 * the logist (edge case 6).
 */
export async function ingestLoadScans(
  inputs: LoadScanInput[],
  ctx: AuditContext,
): Promise<ScanAck[]> {
  if (!ctx.actorId) throw new ScanError('unauthenticated');
  const actorId = ctx.actorId;
  const acks: ScanAck[] = [];

  for (const input of inputs) {
    // eslint-disable-next-line no-await-in-loop
    const ack = await db.transaction(async (tx): Promise<ScanAck> => {
      const batch = await tx.query.batches.findFirst({ where: eq(batches.id, input.batchId) });
      if (!batch) return { clientEventUuid: input.clientEventUuid, result: 'rejected', detail: 'batch_not_found' };
      if (!['forming', 'loading'].includes(batch.status)) {
        return { clientEventUuid: input.clientEventUuid, result: 'rejected', detail: 'batch_not_loading' };
      }

      // Replay? (exact idempotency on the original event uuid)
      const existing = await tx.query.scanEvents.findFirst({
        where: eq(scanEvents.clientEventUuid, input.clientEventUuid),
      });
      if (existing) return { clientEventUuid: input.clientEventUuid, result: 'ok', detail: 'replay' };

      // Resolve code → member boxes.
      const isCrate = /^CR-/i.test(input.code);
      let members: (typeof boxes.$inferSelect)[] = [];
      let crateId: string | null = null;
      if (isCrate) {
        const crate = await tx.query.crates.findFirst({
          where: sql`upper(code) = ${input.code.toUpperCase()}`,
        });
        if (!crate || crate.status !== 'active') {
          return { clientEventUuid: input.clientEventUuid, result: 'unknown_code' };
        }
        crateId = crate.id;
        members = await tx.select().from(boxes).where(eq(boxes.crateId, crate.id)).for('update');
        if (members.length === 0) {
          return { clientEventUuid: input.clientEventUuid, result: 'unknown_code', detail: 'empty_crate' };
        }
      } else {
        const rows = await tx
          .select()
          .from(boxes)
          .where(sql`upper(${boxes.shortCode}) = ${input.code.toUpperCase()}`)
          .for('update');
        if (rows.length === 0) return { clientEventUuid: input.clientEventUuid, result: 'unknown_code' };
        members = rows;
      }

      // Business duplicate: every member already loading in this batch.
      const allLoaded = members.every(
        (b) => b.status === 'loading' && b.currentBatchId === input.batchId,
      );
      if (allLoaded) return { clientEventUuid: input.clientEventUuid, result: 'duplicate' };

      const onPlan = members.every(
        (b) => b.currentBatchId === input.batchId && b.status === 'planned',
      );
      if (!onPlan && !input.addedOnSpot) {
        // Client shows the red screen and may retry with addedOnSpot=true.
        const letters = await lettersFor(tx, members);
        return {
          clientEventUuid: input.clientEventUuid,
          result: 'not_on_plan',
          boxes: letters,
        };
      }
      for (const box of members) {
        const loadable =
          (box.currentBatchId === input.batchId && box.status === 'planned') ||
          (input.addedOnSpot && box.status === 'in_stock' && box.currentWarehouseId === batch.originWarehouseId);
        if (!loadable && !(box.status === 'loading' && box.currentBatchId === input.batchId)) {
          return {
            clientEventUuid: input.clientEventUuid,
            result: 'rejected',
            detail: `box_${box.status}`,
          };
        }
      }

      const toLoad = members.filter((b) => b.status !== 'loading');
      await tx
        .update(boxes)
        .set({ status: 'loading', currentBatchId: input.batchId })
        .where(inArray(boxes.id, toLoad.map((b) => b.id)));
      await tx.insert(boxMovements).values(
        toLoad.map((box) => ({
          boxId: box.id,
          fromWarehouseId: box.currentWarehouseId,
          toWarehouseId: box.currentWarehouseId,
          fromStatus: box.status,
          toStatus: 'loading',
          cause: input.addedOnSpot ? 'loaded_on_spot' : 'load_scan',
          refType: 'batch',
          refId: input.batchId,
          actorId,
        })),
      );
      await tx
        .insert(scanEvents)
        .values(
          members.map((box) => ({
            // Crate fan-out rows get derived ids; single box keeps the original.
            clientEventUuid:
              members.length === 1 ? input.clientEventUuid : uuidv5(box.id, input.clientEventUuid),
            boxId: box.id,
            crateId,
            batchId: input.batchId,
            type: 'load',
            method: crateId ? 'crate' : input.method,
            manualReason: input.method === 'manual' ? input.manualReason || 'manual' : null,
            addedOnSpot: input.addedOnSpot,
            scannedBy: actorId,
            scannedAt: new Date(input.scannedAt),
          })),
        )
        .onConflictDoNothing({ target: scanEvents.clientEventUuid });

      if (batch.status === 'forming') {
        await tx.update(batches).set({ status: 'loading' }).where(eq(batches.id, input.batchId));
        await tx
          .update(loadPlans)
          .set({ status: 'loading' })
          .where(and(eq(loadPlans.batchId, input.batchId), eq(loadPlans.status, 'approved')));
      }
      if (input.addedOnSpot) {
        await emitEvent(tx, {
          type: 'BoxScannedOnLoad',
          payload: {
            batchId: input.batchId,
            batchCode: batch.code,
            addedOnSpot: true,
            reason: input.addedReason || null,
            shortCodes: members.map((b) => b.shortCode),
          },
          entityType: 'batch',
          entityId: input.batchId,
          actorId,
        });
      }
      const letters = await lettersFor(tx, members);
      return { clientEventUuid: input.clientEventUuid, result: 'ok', boxes: letters };
    });
    acks.push(ack);
  }
  return acks;
}

async function lettersFor(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  members: (typeof boxes.$inferSelect)[],
) {
  const lots = await tx
    .select({ id: receiptLots.id, letter: receiptLots.letter })
    .from(receiptLots)
    .where(inArray(receiptLots.id, [...new Set(members.map((m) => m.lotId))]));
  const byId = new Map(lots.map((l) => [l.id, l.letter]));
  return members.map((m) => ({ shortCode: m.shortCode, letter: byId.get(m.lotId) ?? null }));
}

/**
 * Finish loading (W4): planned-but-unscanned boxes revert to stock
 * (short_loaded, edge case 5) and the deviation summary is returned.
 */
export async function finishLoading(batchId: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new ScanError('unauthenticated');
  const actorId = ctx.actorId;
  return db.transaction(async (tx) => {
    const batch = await tx.query.batches.findFirst({ where: eq(batches.id, batchId) });
    if (!batch) throw new ScanError('batch_not_found');
    if (!['forming', 'loading'].includes(batch.status)) throw new ScanError('batch_not_loading');

    const memberBoxes = await tx
      .select()
      .from(boxes)
      .where(eq(boxes.currentBatchId, batchId))
      .for('update');
    const shortLoaded = memberBoxes.filter((b) => b.status === 'planned');
    const loaded = memberBoxes.filter((b) => b.status === 'loading');

    if (shortLoaded.length > 0) {
      await tx
        .update(boxes)
        .set({ status: 'in_stock', currentBatchId: null })
        .where(inArray(boxes.id, shortLoaded.map((b) => b.id)));
      await tx.insert(boxMovements).values(
        shortLoaded.map((box) => ({
          boxId: box.id,
          fromWarehouseId: box.currentWarehouseId,
          toWarehouseId: box.currentWarehouseId,
          fromStatus: 'planned',
          toStatus: 'in_stock',
          cause: 'short_loaded',
          refType: 'batch',
          refId: batchId,
          actorId,
        })),
      );
    }
    await writeAudit(tx, { ...ctx, warehouseId: batch.originWarehouseId }, {
      entityType: 'batch',
      entityId: batchId,
      action: 'status_change',
      after: {
        finishLoading: true,
        loaded: loaded.length,
        shortLoaded: shortLoaded.length,
        addedOnSpot: (
          await tx
            .select({ n: sql<number>`count(*)` })
            .from(scanEvents)
            .where(and(eq(scanEvents.batchId, batchId), eq(scanEvents.addedOnSpot, true)))
        )[0]!.n,
      },
    });
    return {
      loaded: loaded.length,
      shortLoaded: shortLoaded.length,
      shortLoadedCodes: shortLoaded.map((b) => b.shortCode),
    };
  });
}

/** Depart (logist/manager): loaded boxes and the batch go in_transit. */
export async function departBatch(batchId: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new ScanError('unauthenticated');
  const actorId = ctx.actorId;
  return db.transaction(async (tx) => {
    const batch = await tx.query.batches.findFirst({ where: eq(batches.id, batchId) });
    if (!batch) throw new ScanError('batch_not_found');
    if (!['forming', 'loading'].includes(batch.status)) throw new ScanError('batch_not_loading');

    const memberBoxes = await tx
      .select()
      .from(boxes)
      .where(eq(boxes.currentBatchId, batchId))
      .for('update');
    if (memberBoxes.some((b) => b.status === 'planned')) throw new ScanError('finish_loading_first');
    const loaded = memberBoxes.filter((b) => b.status === 'loading');
    if (loaded.length === 0) throw new ScanError('nothing_loaded');

    await tx
      .update(boxes)
      .set({ status: 'in_transit', currentWarehouseId: null })
      .where(inArray(boxes.id, loaded.map((b) => b.id)));
    await tx.insert(boxMovements).values(
      loaded.map((box) => ({
        boxId: box.id,
        fromWarehouseId: box.currentWarehouseId,
        toWarehouseId: batch.destWarehouseId,
        fromStatus: 'loading',
        toStatus: 'in_transit',
        cause: 'batch_departed',
        refType: 'batch',
        refId: batchId,
        actorId,
      })),
    );
    const [updated] = await tx
      .update(batches)
      .set({ status: 'in_transit', departedAt: new Date() })
      .where(eq(batches.id, batchId))
      .returning();
    await tx
      .update(loadPlans)
      .set({ status: 'completed' })
      .where(eq(loadPlans.batchId, batchId));
    await writeAudit(tx, { ...ctx, warehouseId: batch.originWarehouseId }, {
      entityType: 'batch',
      entityId: batchId,
      action: 'status_change',
      after: { status: 'in_transit', boxCount: loaded.length },
    });
    await emitEvent(tx, {
      type: 'BatchDeparted',
      payload: {
        batchId,
        code: batch.code,
        originWarehouseId: batch.originWarehouseId,
        destWarehouseId: batch.destWarehouseId,
        boxCount: loaded.length,
      },
      entityType: 'batch',
      entityId: batchId,
      actorId,
    });
    return { batch: updated!, boxCount: loaded.length };
  });
}
