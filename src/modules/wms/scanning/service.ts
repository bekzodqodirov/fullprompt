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
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { usersWithPermission } from '../../platform/notifications/service';

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
  /** The code as scanned; a crate stays a crate (see the not_on_plan branch). */
  scannedCode?: string;
  detail?: string;
  boxes?: { shortCode: string; letter: string | null }[];
  /**
   * Boxes found inside a scanned CRATE that this truck's plan does not cover.
   * They are NOT loaded — the screen names them so somebody decides, instead
   * of a box riding to Tashkent that the manifest never heard of (#221).
   */
  unplanned?: string[];
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

      // Quick batches (no plan, spec 6.6 internal transfers) load any loose
      // box at the origin without the not-on-plan ceremony.
      const hasPlan = !!(await tx.query.loadPlans.findFirst({
        where: eq(loadPlans.batchId, input.batchId),
      }));
      const looseAtOrigin = (b: (typeof members)[number]) =>
        ['in_stock', 'ready_for_pickup'].includes(b.status) &&
        b.currentWarehouseId === batch.originWarehouseId;

      /**
       * "On this truck" — which is NOT the same as "still `planned`".
       *
       * It used to be `status === 'planned'`, and that stopped a warehouse
       * mid-load. A box already `loading` on THIS batch is the same box on
       * the same truck: it gets that status from a first scan, from an outbox
       * retry over warehouse wifi, or from the second phone working the same
       * door. Demanding `planned` meant the crate holding it stopped being on
       * the plan, came back refused, and — once the screen learned to SHOW
       * refusals — put the red confirm over the scanner and stopped the job.
       */
      const onThisBatch = (b: (typeof members)[number]) =>
        b.currentBatchId === input.batchId && (b.status === 'planned' || b.status === 'loading');

      /**
       * A crate is judged on the boxes of it that belong to this truck.
       *
       * `members` for a crate scan is every box PHYSICALLY inside it, and a
       * crate collects strays: one more box fitted in after the plan was
       * approved, a lot the planner did not list. Requiring all of them made a
       * legitimately planned crate unscannable — the operator is holding a
       * crate the plan asked for and the phone says "not on plan".
       *
       * So the planned boxes load, and the strays are NAMED in the ack rather
       * than silently recorded, because a box on a truck that the manifest and
       * the customs invoice know nothing about is the bug this whole area
       * exists to prevent (#221).
       */
      const planned = members.filter(onThisBatch);
      const unplanned = members.filter((b) => !onThisBatch(b));
      const onPlan = hasPlan
        ? crateId
          ? planned.length > 0
          : members.every(onThisBatch)
        : members.every(looseAtOrigin);
      if (hasPlan && !onPlan && !input.addedOnSpot) {
        // Client shows the red screen and may retry with addedOnSpot=true.
        const letters = await lettersFor(tx, members);
        return {
          clientEventUuid: input.clientEventUuid,
          result: 'not_on_plan',
          boxes: letters,
          // Echoed so the phone can re-open its confirm dialog for the thing
          // that was actually scanned — a crate code must go back as a crate.
          scannedCode: input.code,
        };
      }

      // A crate carrying strays loads only its own boxes unless the operator
      // has already said "load it anyway"; a loose box has nothing to split.
      const recording =
        hasPlan && crateId && !input.addedOnSpot && unplanned.length > 0 ? planned : members;

      for (const box of recording) {
        const loadable =
          onThisBatch(box) || ((input.addedOnSpot || !hasPlan) && looseAtOrigin(box));
        if (!loadable) {
          return {
            clientEventUuid: input.clientEventUuid,
            result: 'rejected',
            detail: `box_${box.status}`,
          };
        }
      }

      const toLoad = recording.filter((b) => b.status !== 'loading');
      // Nothing left to move: a re-scan of a crate whose planned boxes are
      // already aboard (its strays, if any, still named). Without this early
      // answer the empty inserts below THREW, the sync route answered 500,
      // and the phone's outbox retried the same event for ever.
      if (toLoad.length === 0) {
        return {
          clientEventUuid: input.clientEventUuid,
          result: 'duplicate',
          ...(unplanned.length > 0
            ? { unplanned: unplanned.map((b) => b.shortCode), scannedCode: input.code }
            : {}),
        };
      }
      // "Added on spot" is a fact about a BOX, not about the scan: confirming
      // a crate that carries strays must not smear the flag over its planned
      // members — the deviation numbers the logist and the batch register
      // read come from these rows.
      const isSpot = (b: (typeof members)[number]) => input.addedOnSpot && !onThisBatch(b);
      const spotLoaded = toLoad.filter(isSpot);
      const plainLoaded = toLoad.filter((b) => !isSpot(b));
      if (plainLoaded.length) {
        await tx
          .update(boxes)
          .set({ status: 'loading', currentBatchId: input.batchId })
          .where(inArray(boxes.id, plainLoaded.map((b) => b.id)));
      }
      if (spotLoaded.length) {
        await tx
          .update(boxes)
          .set({
            status: 'loading',
            currentBatchId: input.batchId,
            // The manifest marks on-spot boxes from this flag.
            flags: ['added_on_spot'],
          })
          .where(inArray(boxes.id, spotLoaded.map((b) => b.id)));
      }
      await tx.insert(boxMovements).values(
        toLoad.map((box) => ({
          boxId: box.id,
          fromWarehouseId: box.currentWarehouseId,
          toWarehouseId: box.currentWarehouseId,
          fromStatus: box.status,
          toStatus: 'loading',
          cause: isSpot(box) ? 'loaded_on_spot' : 'load_scan',
          refType: 'batch',
          refId: input.batchId,
          actorId,
        })),
      );
      await tx
        .insert(scanEvents)
        .values(
          // Only the boxes this scan actually put on the truck — recording a
          // row per crate member on every re-scan made the register's counts
          // grow without any box moving.
          toLoad.map((box) => ({
            // Crate fan-out rows get derived ids; single box keeps the original.
            clientEventUuid:
              toLoad.length === 1 ? input.clientEventUuid : uuidv5(box.id, input.clientEventUuid),
            boxId: box.id,
            crateId,
            batchId: input.batchId,
            type: 'load',
            method: crateId ? 'crate' : input.method,
            manualReason: input.method === 'manual' ? input.manualReason || 'manual' : null,
            addedOnSpot: isSpot(box),
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
      if (spotLoaded.length > 0) {
        await emitEvent(tx, {
          type: 'BoxScannedOnLoad',
          payload: {
            batchId: input.batchId,
            batchCode: batch.code,
            addedOnSpot: true,
            reason: input.addedReason || null,
            // Only the boxes that really joined off-plan — the logist's alert
            // must not list the crate's planned members as deviations.
            shortCodes: spotLoaded.map((b) => b.shortCode),
          },
          entityType: 'batch',
          entityId: input.batchId,
          actorId,
        });
      }
      const letters = await lettersFor(tx, recording);
      return {
        clientEventUuid: input.clientEventUuid,
        result: 'ok',
        boxes: letters,
        ...(recording.length < members.length
          ? { unplanned: unplanned.map((b) => b.shortCode), scannedCode: input.code }
          : {}),
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
 * Take a scanned box (or crate) back OFF a truck that has not departed
 * (owner, 2026-08-25: «yukni yuklab bo'lib qaytarib tushirishga to'g'ri
 * kelganda … tushishni imkoni yo'q sistemada»). His answer B: the box leaves
 * the batch AND the plan entirely and goes back to the shelf — re-loading it
 * is a fresh scan, with the not-on-plan ceremony if the plan no longer
 * covers it.
 *
 * ONLINE-only, unlike the load scan, and deliberately so: a removal is a
 * decision made WITH the logist, not a rhythm kept at three boxes a second,
 * and an offline reversal queue would have to reconcile against the load
 * queue's unsent scans — two outboxes disagreeing about one box.
 *
 * A single box that leaves a crate whose OTHER members stay aboard loses its
 * `crateId`: the carton was physically taken out (a whole crate coming off
 * is scanned as the crate). A crate-code removal keeps every member's
 * membership — the yashik goes back to the shelf intact.
 */
export async function removeLoadedCode(batchId: string, code: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new ScanError('unauthenticated');
  const actorId = ctx.actorId;
  return db.transaction(async (tx) => {
    const batch = await tx.query.batches.findFirst({ where: eq(batches.id, batchId) });
    if (!batch) throw new ScanError('batch_not_found');
    // Once the truck has departed this is `resolveMissing`'s job at the other
    // end, not a loading correction.
    if (!['forming', 'loading'].includes(batch.status)) throw new ScanError('batch_not_loading');

    const isCrate = /^CR-/i.test(code);
    let members: (typeof boxes.$inferSelect)[];
    if (isCrate) {
      const crate = await tx.query.crates.findFirst({
        where: sql`upper(code) = ${code.toUpperCase()}`,
      });
      if (!crate) throw new ScanError('unknown_code');
      members = await tx.select().from(boxes).where(eq(boxes.crateId, crate.id)).for('update');
    } else {
      members = await tx
        .select()
        .from(boxes)
        .where(sql`upper(${boxes.shortCode}) = ${code.toUpperCase()}`)
        .for('update');
      if (members.length === 0) throw new ScanError('unknown_code');
    }

    // Only what THIS truck's scan put aboard comes off — a planned-but-
    // unscanned box is not on the truck, and somebody else's cargo is not
    // this screen's to move.
    const aboard = members.filter((b) => b.status === 'loading' && b.currentBatchId === batchId);
    if (aboard.length === 0) throw new ScanError('not_loaded_here');

    for (const box of aboard) {
      await tx
        .update(boxes)
        .set({
          status: 'in_stock',
          currentBatchId: null,
          // An on-spot flag picked up on this load must not ride into the
          // box's next life on the shelf (the batch-cancel rule).
          flags: [],
          ...(!isCrate && box.crateId ? { crateId: null } : {}),
        })
        .where(eq(boxes.id, box.id));
    }
    await tx.insert(boxMovements).values(
      aboard.map((box) => ({
        boxId: box.id,
        fromWarehouseId: box.currentWarehouseId,
        toWarehouseId: box.currentWarehouseId,
        fromStatus: 'loading',
        toStatus: 'in_stock',
        cause: 'load_removed',
        refType: 'batch',
        refId: batchId,
        actorId,
      })),
    );
    await writeAudit(tx, { ...ctx, warehouseId: batch.originWarehouseId }, {
      entityType: 'batch',
      entityId: batchId,
      action: 'update',
      after: { loadRemoved: aboard.map((b) => b.shortCode), code },
    });
    return { removed: aboard.map((b) => b.shortCode) };
  });
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
    const summary = {
      loaded: loaded.length,
      shortLoaded: shortLoaded.length,
      shortLoadedCodes: shortLoaded.map((b) => b.shortCode),
      addedOnSpot: Number(
        (
          await tx
            .select({ n: sql<number>`count(*)` })
            .from(scanEvents)
            .where(
              and(
                eq(scanEvents.batchId, batchId),
                eq(scanEvents.addedOnSpot, true),
                eq(scanEvents.type, 'load'),
              ),
            )
        )[0]!.n,
      ),
    };
    return { ...summary, batchCode: batch.code };
  }).then(async (result) => {
    // The loading summary (staff bot, owner's item 6): the people who plan
    // the trucks learn how it went without opening anything. AFTER the
    // transaction — a Telegram row must never be able to roll a load back —
    // and never to the person who just pressed the button.
    await notifyLoadSummary(batchId, result, ctx.actorId).catch(() => {});
    return {
      loaded: result.loaded,
      shortLoaded: result.shortLoaded,
      shortLoadedCodes: result.shortLoadedCodes,
    };
  });
}

/**
 * Who is told how a truck went: whoever plans them. Resolved from the
 * EDITABLE grants (#170), so a role the owner invents is included the day it
 * gets `plans.manage` — never a compiled list of role names.
 */
async function notifyLoadSummary(
  batchId: string,
  result: { batchCode: string; loaded: number; shortLoaded: number; shortLoadedCodes: string[]; addedOnSpot: number },
  actorId: string | null | undefined,
): Promise<void> {
  const userIds = await usersWithPermission('plans.manage');
  if (userIds.length === 0) return;
  const appUrl = process.env.APP_URL ?? '';
  await notifyStaffTelegram({
    userIds,
    type: 'LoadFinished',
    exceptUserId: actorId ?? null,
    text:
      `🚚 ${result.batchCode} — yuklash tugadi\n` +
      `Yuklandi: ${result.loaded} karobka` +
      (result.shortLoaded
        ? `\n↩️ Qolib ketdi: ${result.shortLoaded} — ${result.shortLoadedCodes.slice(0, 12).join(', ')}`
        : '') +
      (result.addedOnSpot ? `\n⚠️ Qo‘shib yuklandi: ${result.addedOnSpot}` : '') +
      `\n${appUrl}/batches/${batchId}`,
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
