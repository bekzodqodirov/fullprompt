import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clientTransactions,
  costEntries,
  driverDevices,
  loadPlans,
  receiptLots,
  receipts,
  scanEvents,
  warehouses,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';
import { ScanError } from './service';

export const unloadScanSchema = z.object({
  clientEventUuid: z.string().uuid(),
  batchId: z.string().uuid(),
  code: z.string().trim().min(3).max(40),
  method: z.enum(['qr', 'manual']),
  manualReason: z.string().trim().max(200).optional().or(z.literal('')),
  scannedAt: z.string().datetime(),
});
export type UnloadScanInput = z.infer<typeof unloadScanSchema>;

export interface UnloadAck {
  clientEventUuid: string;
  result: 'ok' | 'auto_transfer' | 'duplicate' | 'unknown_code' | 'rejected';
  detail?: string;
  boxes?: { shortCode: string; letter: string | null }[];
}

/**
 * W5 unload ingest (spec 6.5). On-manifest boxes land in_stock at the
 * destination. A KNOWN box that is NOT on this manifest is auto-transferred
 * here regardless of its recorded location — reality wins (edge case 4):
 * flagged `undocumented_transfer`, correcting movement, logist alerted.
 * Unknown codes come back as `unknown_code` → the phone offers the
 * unclaimed mini-intake. Idempotent by clientEventUuid.
 */
export async function ingestUnloadScans(
  inputs: UnloadScanInput[],
  ctx: AuditContext,
): Promise<UnloadAck[]> {
  if (!ctx.actorId) throw new ScanError('unauthenticated');
  const actorId = ctx.actorId;
  const acks: UnloadAck[] = [];

  for (const input of inputs) {
    const ack = await db.transaction(async (tx): Promise<UnloadAck> => {
      const batch = await tx.query.batches.findFirst({ where: eq(batches.id, input.batchId) });
      if (!batch) return { clientEventUuid: input.clientEventUuid, result: 'rejected', detail: 'batch_not_found' };
      if (!['in_transit', 'arrived'].includes(batch.status)) {
        return { clientEventUuid: input.clientEventUuid, result: 'rejected', detail: 'batch_not_unloading' };
      }

      const existing = await tx.query.scanEvents.findFirst({
        where: eq(scanEvents.clientEventUuid, input.clientEventUuid),
      });
      if (existing) return { clientEventUuid: input.clientEventUuid, result: 'ok', detail: 'replay' };

      // First scan marks arrival.
      if (batch.status === 'in_transit') {
        await tx
          .update(batches)
          .set({ status: 'arrived', arrivedAt: new Date() })
          .where(eq(batches.id, input.batchId));
      }

      const isCrate = /^CR-/i.test(input.code);
      let members: (typeof boxes.$inferSelect)[] = [];
      let crateId: string | null = null;
      if (isCrate) {
        const crate = await tx.query.crates.findFirst({
          where: sql`upper(code) = ${input.code.toUpperCase()}`,
        });
        if (!crate) return { clientEventUuid: input.clientEventUuid, result: 'unknown_code' };
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

      // UZ side (spec 6.6): unloading at a customs/distribution warehouse puts
      // cargo straight into ready_for_pickup.
      const destWh = (await tx.query.warehouses.findFirst({
        where: eq(warehouses.id, batch.destWarehouseId),
      }))!;
      const landedStatus = ['customs', 'distribution'].includes(destWh.type)
        ? 'ready_for_pickup'
        : 'in_stock';

      // Business duplicate: everything already landed at this destination.
      const allDone = members.every(
        (b) => b.status === landedStatus && b.currentWarehouseId === batch.destWarehouseId,
      );
      if (allDone) return { clientEventUuid: input.clientEventUuid, result: 'duplicate' };

      for (const box of members) {
        if (['issued', 'void'].includes(box.status)) {
          return { clientEventUuid: input.clientEventUuid, result: 'rejected', detail: `box_${box.status}` };
        }
      }

      const onManifest = members.every(
        (b) => b.currentBatchId === input.batchId && b.status === 'in_transit',
      );
      const rogue = members.filter(
        (b) => !(b.currentBatchId === input.batchId && b.status === 'in_transit'),
      );

      const toMove = members.filter(
        (b) => !(b.status === landedStatus && b.currentWarehouseId === batch.destWarehouseId),
      );
      // Reality wins: everything scanned here IS here now. Rogue boxes keep
      // no stale crate link (their crate stayed wherever it really is).
      for (const box of toMove) {
        const isRogue = rogue.includes(box);
        await tx
          .update(boxes)
          .set({
            status: landedStatus,
            currentWarehouseId: batch.destWarehouseId,
            currentBatchId: null,
            statusReason: null,
            ...(isRogue
              ? { crateId: crateId ?? null, flags: ['undocumented_transfer'] }
              : {}),
          })
          .where(eq(boxes.id, box.id));
      }
      await tx.insert(boxMovements).values(
        toMove.map((box) => ({
          boxId: box.id,
          fromWarehouseId: box.currentWarehouseId,
          toWarehouseId: batch.destWarehouseId,
          fromStatus: box.status,
          toStatus: landedStatus,
          cause: rogue.includes(box) ? 'undocumented_transfer' : 'unload_scan',
          refType: 'batch',
          refId: input.batchId,
          actorId,
        })),
      );

      // Client arrival summary (spec 6.6): emit per client so sales managers
      // get the ready-for-pickup draft message.
      if (landedStatus === 'ready_for_pickup' && toMove.length > 0) {
        const lotRows = await tx
          .select({ lotId: receiptLots.id, clientId: receipts.clientId })
          .from(receiptLots)
          .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
          .where(inArray(receiptLots.id, [...new Set(toMove.map((b) => b.lotId))]));
        const clientByLot = new Map(lotRows.map((r) => [r.lotId, r.clientId]));
        const perClient = new Map<string, number>();
        for (const box of toMove) {
          const cid = clientByLot.get(box.lotId);
          if (cid) perClient.set(cid, (perClient.get(cid) ?? 0) + 1);
        }
        for (const [cid, n] of perClient) {
          await emitEvent(tx, {
            type: 'ReadyForPickup',
            payload: {
              clientId: cid,
              warehouseId: batch.destWarehouseId,
              warehouseCode: destWh.code,
              batchCode: batch.code,
              boxCount: n,
            },
            entityType: 'batch',
            entityId: input.batchId,
            actorId,
          });
        }
      }
      await tx
        .insert(scanEvents)
        .values(
          members.map((box) => ({
            clientEventUuid:
              members.length === 1 ? input.clientEventUuid : uuidv5(box.id, input.clientEventUuid),
            boxId: box.id,
            crateId,
            batchId: input.batchId,
            type: 'unload',
            method: crateId ? 'crate' : input.method,
            manualReason: input.method === 'manual' ? input.manualReason || 'manual' : null,
            addedOnSpot: rogue.includes(box),
            scannedBy: actorId,
            scannedAt: new Date(input.scannedAt),
          })),
        )
        .onConflictDoNothing({ target: scanEvents.clientEventUuid });

      if (rogue.length > 0) {
        await emitEvent(tx, {
          type: 'UndocumentedTransfer',
          payload: {
            batchId: input.batchId,
            batchCode: batch.code,
            warehouseId: batch.destWarehouseId,
            shortCodes: rogue.map((b) => b.shortCode),
          },
          entityType: 'batch',
          entityId: input.batchId,
          actorId,
        });
      }
      const letters = await lettersFor(tx, members);
      return {
        clientEventUuid: input.clientEventUuid,
        result: onManifest ? 'ok' : 'auto_transfer',
        boxes: letters,
      };
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
 * Boxes that travelled with this batch — INCLUDING the ones already accepted
 * at the destination.
 *
 * Accepting a box clears its `current_batch_id`, so a plain
 * `current_batch_id = batch` filter loses it at exactly the moment it matters:
 * the unload screen's counter went down instead of up, and a page reload
 * showed nothing had been accepted at all. What departed is written to
 * box_movements once and never changes.
 */
export function batchMemberFilter(batchId: string) {
  return sql`(${boxes.currentBatchId} = ${batchId} OR EXISTS (
    SELECT 1 FROM box_movements bm
    WHERE bm.box_id = ${boxes.id}
      AND bm.ref_type = 'batch' AND bm.ref_id = ${batchId} AND bm.cause = 'batch_departed'
  ))`;
}

/** How many manifest boxes are still waiting to be accepted here. */
export async function remainingToUnload(batchId: string): Promise<string[]> {
  const rows = await db
    .select({ shortCode: boxes.shortCode })
    .from(boxes)
    .where(sql`${boxes.currentBatchId} = ${batchId} AND ${boxes.status} = 'in_transit'`)
    .orderBy(boxes.shortCode);
  return rows.map((r) => r.shortCode);
}

/**
 * Accept every remaining manifest box at once, without scanning.
 *
 * The owner asked for this after finishing an unload cost him a truckload
 * flagged "missing in transit": the whole truck was standing in the yard, but
 * the only one-tap action available was the one that declares cargo lost.
 * Runs each box through the normal unload ingest, so movements, scan events,
 * the ready-for-pickup client notice and the audit trail are identical to a
 * scanned unload — only the method is recorded as a manual bulk accept.
 */
export async function unloadRemaining(batchId: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new ScanError('unauthenticated');
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) throw new ScanError('batch_not_found');
  if (!['in_transit', 'arrived'].includes(batch.status)) throw new ScanError('batch_not_unloading');

  const remaining = await remainingToUnload(batchId);
  if (remaining.length === 0) return { accepted: 0 };

  const scannedAt = new Date().toISOString();
  const acks = await ingestUnloadScans(
    remaining.map((shortCode) => ({
      // Derived from the batch, so pressing the button twice replays instead
      // of writing a second scan event.
      clientEventUuid: uuidv5(`bulk:${shortCode}`, batchId),
      batchId,
      code: shortCode,
      method: 'manual' as const,
      manualReason: 'bulk_accept',
      scannedAt,
    })),
    ctx,
  );
  const accepted = acks.filter((a) => ['ok', 'auto_transfer'].includes(a.result)).length;
  await writeAudit(db, { ...ctx, warehouseId: batch.destWarehouseId }, {
    entityType: 'batch',
    entityId: batchId,
    action: 'update',
    after: { bulkUnload: accepted, shortCodes: remaining },
  });
  return { accepted };
}

/**
 * Finish unload (spec 6.5): manifest boxes never scanned here stay
 * `in_transit` flagged `missing_in_transit` + alert; batch → `unloaded`.
 */
export async function finishUnload(batchId: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new ScanError('unauthenticated');
  const actorId = ctx.actorId;
  return db.transaction(async (tx) => {
    const batch = await tx.query.batches.findFirst({ where: eq(batches.id, batchId) });
    if (!batch) throw new ScanError('batch_not_found');
    if (!['in_transit', 'arrived'].includes(batch.status)) throw new ScanError('batch_not_unloading');

    const missing = await tx
      .select()
      .from(boxes)
      .where(sql`${boxes.currentBatchId} = ${batchId} AND ${boxes.status} = 'in_transit'`)
      .for('update');
    if (missing.length > 0) {
      await tx
        .update(boxes)
        .set({ flags: ['missing_in_transit'] })
        .where(inArray(boxes.id, missing.map((b) => b.id)));
      await emitEvent(tx, {
        type: 'MissingInTransit',
        payload: {
          batchId,
          batchCode: batch.code,
          shortCodes: missing.map((b) => b.shortCode),
        },
        entityType: 'batch',
        entityId: batchId,
        actorId,
      });
    }
    const [updated] = await tx
      .update(batches)
      .set({ status: 'unloaded', arrivedAt: batch.arrivedAt ?? new Date() })
      .where(eq(batches.id, batchId))
      .returning();
    await writeAudit(tx, { ...ctx, warehouseId: batch.destWarehouseId }, {
      entityType: 'batch',
      entityId: batchId,
      action: 'status_change',
      after: { status: 'unloaded', missing: missing.length },
    });
    return {
      batch: updated!,
      missing: missing.map((b) => b.shortCode),
    };
  });
}

export const resolveMissingSchema = z.object({
  boxId: z.string().uuid(),
  resolution: z.enum(['found_at_origin', 'found_here']),
});

/** Resolve a missing-in-transit box (spec 6.5 resolution actions). */
export async function resolveMissing(
  input: z.infer<typeof resolveMissingSchema>,
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new ScanError('unauthenticated');
  const actorId = ctx.actorId;
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(boxes).where(eq(boxes.id, input.boxId)).for('update');
    const box = rows[0];
    if (!box) throw new ScanError('box_not_found');
    const flags = Array.isArray(box.flags) ? (box.flags as string[]) : [];
    if (!flags.includes('missing_in_transit') || !box.currentBatchId) {
      throw new ScanError('not_missing');
    }
    const batch = (await tx.query.batches.findFirst({
      where: eq(batches.id, box.currentBatchId),
    }))!;
    const foundHere = input.resolution === 'found_here';
    const targetWh = foundHere ? batch.destWarehouseId : batch.originWarehouseId;
    // A box found at the destination has to land exactly where a scanned one
    // lands, or it would sit in `in_stock` at a customs/distribution warehouse
    // and never show up as ready for the client.
    const targetWhRow = (await tx.query.warehouses.findFirst({
      where: eq(warehouses.id, targetWh),
    }))!;
    const landedStatus =
      foundHere && ['customs', 'distribution'].includes(targetWhRow.type)
        ? 'ready_for_pickup'
        : 'in_stock';

    await tx
      .update(boxes)
      .set({
        status: landedStatus,
        currentWarehouseId: targetWh,
        currentBatchId: null,
        flags: [],
      })
      .where(eq(boxes.id, box.id));
    await tx.insert(boxMovements).values({
      boxId: box.id,
      fromWarehouseId: box.currentWarehouseId,
      toWarehouseId: targetWh,
      fromStatus: box.status,
      toStatus: landedStatus,
      cause: input.resolution,
      refType: 'batch',
      refId: batch.id,
      actorId,
    });
    await writeAudit(tx, { ...ctx, warehouseId: targetWh }, {
      entityType: 'box',
      entityId: box.id,
      action: 'status_change',
      after: { resolution: input.resolution, shortCode: box.shortCode },
    });
    return { shortCode: box.shortCode, resolution: input.resolution };
  });
}

/** Close the batch (final state; costs stay attachable — recompute is M6). */
export async function closeBatch(batchId: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new ScanError('unauthenticated');
  return db.transaction(async (tx) => {
    const batch = await tx.query.batches.findFirst({ where: eq(batches.id, batchId) });
    if (!batch) throw new ScanError('batch_not_found');
    if (batch.status !== 'unloaded') throw new ScanError('finish_unload_first');
    const [updated] = await tx
      .update(batches)
      .set({ status: 'closed', closedAt: new Date() })
      .where(eq(batches.id, batchId))
      .returning();
    await writeAudit(tx, { ...ctx, warehouseId: batch.destWarehouseId }, {
      entityType: 'batch',
      entityId: batchId,
      action: 'status_change',
      after: { status: 'closed' },
    });
    return updated!;
  });
}

/**
 * Cancel a batch that never went anywhere, and give its cargo back.
 *
 * The owner's problem, in his words: "dev payitida productionga partiyalar
 * planlar yaratib qo'ygandim … endi shularni o'chira olmayabman." Test batches
 * from before go-live sit on the board next to real trucks, and there was no
 * way to get rid of them — every other state had an action and this one had
 * none.
 *
 * `cancelled` is NOT a new idea: it has been in the batch CHECK constraint
 * since M3, the board already files it under the archive drawer, the batch
 * card already hides its controls, and the tracking service already refuses a
 * cancelled batch. The state was understood everywhere and simply unreachable
 * — this is the missing door, not a new room.
 *
 * A SOFT cancel, deliberately, and the house pattern (receipt void, box void,
 * cost void): the row stays, with a reason and an audit trail. A hard DELETE
 * would take the batch out from under `box_movements` rows that describe what
 * really happened to real boxes — those reference a batch by `ref_id` with no
 * foreign key, so nothing would stop it and nothing would complain, and the
 * history of a box would point at a batch that no longer exists.
 *
 * Refused for anything that has left, carries money, or holds a box that is
 * not simply waiting — see the guards. What it is FOR is a batch that was
 * created and then abandoned.
 */
export async function cancelBatch(batchId: string, reason: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new ScanError('unauthenticated');
  const actorId = ctx.actorId;
  const why = reason.trim();
  // A reason, like every other void in this system: six months from now the
  // only question anyone asks about a cancelled batch is why.
  if (why.length < 3) throw new ScanError('reason_required');

  return db.transaction(async (tx) => {
    const batch = await tx.query.batches.findFirst({ where: eq(batches.id, batchId) });
    if (!batch) throw new ScanError('batch_not_found');
    // Once the truck has left, the batch is a real journey: its code is on the
    // customs papers and its boxes are somewhere between two countries.
    if (!['forming', 'loading'].includes(batch.status)) throw new ScanError('batch_already_departed');

    // Money first, because money is the guard that cannot be undone by giving
    // the boxes back. A batch with a live cost or a charge raised against it
    // is one somebody has already accounted for.
    const [costs] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(costEntries)
      .where(and(eq(costEntries.batchId, batchId), isNull(costEntries.voidedAt)));
    if (Number(costs!.n) > 0) throw new ScanError('batch_has_costs');
    const [charges] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(clientTransactions)
      .where(and(eq(clientTransactions.batchId, batchId), isNull(clientTransactions.voidedAt)));
    if (Number(charges!.n) > 0) throw new ScanError('batch_has_charges');

    const memberBoxes = await tx
      .select()
      .from(boxes)
      .where(eq(boxes.currentBatchId, batchId))
      .for('update');
    // Before departure a member box is `planned` or `loading` and nothing
    // else. Anything further along means this batch is not what it looks
    // like, and giving those boxes back to stock would be a lie about where
    // they are — refuse rather than guess.
    const stuck = memberBoxes.filter((b) => !['planned', 'loading'].includes(b.status));
    if (stuck.length > 0) throw new ScanError('batch_has_moved_boxes');

    if (memberBoxes.length > 0) {
      await tx
        .update(boxes)
        .set({ status: 'in_stock', currentBatchId: null })
        .where(inArray(boxes.id, memberBoxes.map((b) => b.id)));
      // The same shape `finishLoading` writes for a short-loaded box: the
      // cargo goes back to the shelf it never left, and the movement says why.
      await tx.insert(boxMovements).values(
        memberBoxes.map((box) => ({
          boxId: box.id,
          fromWarehouseId: box.currentWarehouseId,
          toWarehouseId: box.currentWarehouseId,
          fromStatus: box.status,
          toStatus: 'in_stock',
          cause: 'batch_cancelled',
          refType: 'batch',
          refId: batchId,
          actorId,
        })),
      );
    }

    // The plan that produced this batch goes with it — leaving it `approved`
    // would leave a plan claiming a batch that no longer forms.
    await tx
      .update(loadPlans)
      .set({ status: 'cancelled' })
      .where(eq(loadPlans.batchId, batchId));

    // A paired driver phone must stop being able to report against a batch
    // that is over. The token is cleared, so the handset falls silent rather
    // than filing positions nobody reads.
    await tx
      .update(driverDevices)
      .set({ revokedAt: new Date(), pairCode: null, tokenHash: null })
      .where(and(eq(driverDevices.batchId, batchId), isNull(driverDevices.revokedAt)));

    const [updated] = await tx
      .update(batches)
      .set({ status: 'cancelled' })
      .where(eq(batches.id, batchId))
      .returning();
    await writeAudit(tx, { ...ctx, warehouseId: batch.originWarehouseId }, {
      entityType: 'batch',
      entityId: batchId,
      action: 'status_change',
      before: { status: batch.status },
      after: { status: 'cancelled', reason: why, boxesReleased: memberBoxes.length },
    });
    return { batch: updated!, boxesReleased: memberBoxes.length };
  });
}
