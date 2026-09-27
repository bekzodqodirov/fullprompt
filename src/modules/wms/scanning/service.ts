import { and, eq, inArray, sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';
import { db, type Db, type Tx } from '../../platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clients,
  loadPlans,
  receiptLots,
  receipts,
  scanEvents,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { usersWithPermission } from '../../platform/notifications/service';
import { notifyPricedCargoLeft } from '../finance/off-truck';
import {
  COUNT_LOAD_REASON,
  countedOnTruckSql,
  isServerScanReason,
  lockTruckLoading,
  lotModeOnTruck,
  type DoorOpts,
} from './count-rules';
import { qrlessRowSql } from '../labels/qrless-sql';
import { codeIdentity } from '../labels/code-identity';
import { aboardFilter } from './unload';

export class ScanError extends Error {
  /**
   * `detail` carries what a refusal must NAME (0112: «yuklash tugadi» refused
   * over uncounted QR-siz lots says which ones). Every older refusal is a
   * bare code, as it always was.
   */
  constructor(
    public readonly code: string,
    public readonly detail?: { lots?: string[] },
  ) {
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
    const ack = await db.transaction((tx) => loadScanInTx(tx, input, actorId, {}));
    acks.push(ack);
  }
  return acks;
}

/**
 * One load input, inside the caller's transaction — the body the phone's
 * sync and the office's count door (0112) share, so a counted carton gets
 * exactly the movement, scan event, costing trail and alarms a scanned one
 * does. `opts` is the door's; the phone passes `{}`.
 */
export async function loadScanInTx(
  tx: Tx,
  input: LoadScanInput,
  actorId: string,
  opts: DoorOpts,
): Promise<ScanAck> {
  // A server door's reason on a scan that did not come through a server
  // door is a forgery (0112): a `count_load` from a phone's outbox would
  // make a lot «counted» and lock the operators out of it. Refused before
  // anything is read — `rejected` is not a 400, so the outbox's bisect is
  // untouched and the phone simply takes its green mark back (#531).
  if (!opts.door && input.method === 'manual' && isServerScanReason(input.manualReason)) {
    return {
      clientEventUuid: input.clientEventUuid,
      result: 'rejected',
      detail: 'reserved_reason',
      scannedCode: input.code,
    };
  }
  if (opts.door && input.manualReason !== opts.door) throw new ScanError('door_reason_mismatch');

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
    // A count door names the carton it chose by primary key; the code it
    // posts must still be that carton's, or the press and the record would
    // describe two different boxes.
    const rows = opts.boxId
      ? await tx.select().from(boxes).where(eq(boxes.id, opts.boxId)).for('update')
      : await tx
          .select()
          .from(boxes)
          .where(sql`upper(${boxes.shortCode}) = ${input.code.toUpperCase()}`)
          .for('update');
    if (rows.length === 0) return { clientEventUuid: input.clientEventUuid, result: 'unknown_code' };
    if (opts.boxId && rows[0]!.shortCode.toUpperCase() !== input.code.toUpperCase()) {
      throw new ScanError('door_box_mismatch');
    }
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

  // A lot the office counts is the office's on this truck (0112, Q4/Q8):
  // counted here already, or holding a stickerless carton among this
  // truck's rows. The phone refuses it in words; the count door itself
  // passes. A crate is always the phone's — it is scanned as the crate.
  if (!crateId && !opts.door && members[0]!.crateId === null) {
    const mode = await lotModeOnTruck(tx, {
      batchId: input.batchId,
      lotId: members[0]!.lotId,
      side: 'load',
      countedSide: 'load',
      quickOriginId: hasPlan ? null : batch.originWarehouseId,
    });
    if (mode) {
      return {
        clientEventUuid: input.clientEventUuid,
        result: 'rejected',
        detail: mode === 'counted' ? 'lot_counted' : 'qr_less_count_only',
        scannedCode: input.code,
      };
    }
  }
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
  // A count door sends ONE alarm for its whole press, not one per carton.
  if (spotLoaded.length > 0 && !opts.quietSpot) {
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
    // One loading change at a time per truck (0112): a count press must
    // never read a truck this call is half-way through changing.
    await lockTruckLoading(tx, batchId);
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
    // A lot the office counted onto this truck is the office's number (0112,
    // Q3): only the count box on the batch card changes it. A carton taken
    // off here would leave «48» on the office's screen over 47 on the truck.
    // A crate is scanned as the crate, and its events never count a lot.
    if (!isCrate && aboard[0]!.crateId === null) {
      const [mark] = (await tx.execute(
        sql`SELECT ${countedOnTruckSql(batchId, sql`${aboard[0]!.lotId}::uuid`, 'load')} AS counted`,
      )) as unknown as { counted: boolean }[];
      if (mark?.counted) throw new ScanError('lot_counted');
    }

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
 *
 * One refusal since 0112 (decision 28): a QR-siz lot still reserved on the
 * truck that NOBODY counted. The phone cannot scan it and the office has not
 * said how many went on, so «yuklash tugadi» would quietly send the whole
 * lot back to the shelf — the one moment the office is standing at the truck
 * with the number. The refusal names the lots; a count-door holder at the
 * origin may finish anyway (`dropQrless`), and a counted lot short-loads its
 * remainder like any other.
 */
export async function finishLoading(
  batchId: string,
  ctx: AuditContext,
  opts: { dropQrless?: boolean } = {},
) {
  if (!ctx.actorId) throw new ScanError('unauthenticated');
  const actorId = ctx.actorId;
  return db.transaction(async (tx) => {
    // One loading change at a time per truck (0112): a count press must
    // never read a truck this call is half-way through changing.
    await lockTruckLoading(tx, batchId);
    const batch = await tx.query.batches.findFirst({ where: eq(batches.id, batchId) });
    if (!batch) throw new ScanError('batch_not_found');
    if (!['forming', 'loading'].includes(batch.status)) throw new ScanError('batch_not_loading');
    if (!opts.dropQrless) {
      const uncounted = (await qrlessUncountedByTruck(tx, [batchId])).get(batchId) ?? [];
      if (uncounted.length > 0) {
        throw new ScanError('qrless_uncounted', { lots: uncounted.map((lot) => lot.label) });
      }
    }

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
    // Cartons that went on beyond the plan AND are still on — distinct, and
    // off the truck's real cargo rather than its scan history (decision 25):
    // an office count dialled down, or a phone's removal, took some back,
    // and a scan event stays for ever.
    const addedOnSpot = Number(
      (
        await tx
          .select({ n: sql<number>`count(DISTINCT ${scanEvents.boxId})` })
          .from(scanEvents)
          .innerJoin(boxes, eq(boxes.id, scanEvents.boxId))
          .where(
            and(
              eq(scanEvents.batchId, batchId),
              eq(scanEvents.addedOnSpot, true),
              eq(scanEvents.type, 'load'),
              aboardFilter(batchId),
            ),
          )
      )[0]!.n,
    );
    await writeAudit(tx, { ...ctx, warehouseId: batch.originWarehouseId }, {
      entityType: 'batch',
      entityId: batchId,
      action: 'status_change',
      after: {
        finishLoading: true,
        loaded: loaded.length,
        shortLoaded: shortLoaded.length,
        addedOnSpot,
        ...(opts.dropQrless ? { droppedQrless: true } : {}),
      },
    });
    const summary = {
      loaded: loaded.length,
      shortLoaded: shortLoaded.length,
      shortLoadedCodes: shortLoaded.map((b) => b.shortCode),
      addedOnSpot,
    };
    return { ...summary, batchCode: batch.code, shortLoadedIds: shortLoaded.map((b) => b.id) };
  }).then(async (result) => {
    // The loading summary (staff bot, owner's item 6): the people who plan
    // the trucks learn how it went without opening anything. AFTER the
    // transaction — a Telegram row must never be able to roll a load back —
    // and never to the person who just pressed the button.
    await notifyLoadSummary(batchId, result, ctx.actorId).catch(() => {});
    // A price whose cargo this press left behind (0104, Q21a) — only THIS
    // call's short-loaded cartons, so a second press announces nothing.
    await notifyPricedCargoLeft(batchId, result.shortLoadedIds, ctx.actorId).catch(() => {});
    return {
      loaded: result.loaded,
      shortLoaded: result.shortLoaded,
      shortLoadedCodes: result.shortLoadedCodes,
    };
  });
}

/**
 * The QR-siz lots a truck still holds RESERVED that nobody has counted onto
 * it — per truck, in one statement for however many trucks (decision 28).
 * «yuklash tugadi» refuses over these, and the truck board shows the same
 * set as «sanash kutilmoqda», so the refusal is never a surprise (#513).
 *
 * A lot is QR-siz on a truck when any of ITS loose cartons on that truck is
 * stickerless (the kernel's rule, `qrlessRowSql`). «Counted» is the kernel's
 * load-side marker (`countedOnTruckSql`) read against each truck in the list
 * rather than one bound id — that fragment takes a single truck, and a board
 * of forty cannot ask forty times. The handle is REQUIRED: «yuklash tugadi»
 * asks from inside its own transaction (#714).
 */
export async function qrlessUncountedByTruck(
  exec: Db | Tx,
  batchIds: string[],
): Promise<Map<string, { lotId: string; label: string }[]>> {
  const out = new Map<string, { lotId: string; label: string }[]>();
  if (batchIds.length === 0) return out;
  const rows = (await exec.execute(sql`
    SELECT DISTINCT pb.current_batch_id AS batch_id, l.id AS lot_id, l.letter,
           r.unclaimed_marking AS marking, c.client_code
      FROM boxes pb
      JOIN receipt_lots l ON l.id = pb.lot_id
      JOIN receipts r ON r.id = l.receipt_id
      LEFT JOIN clients c ON c.id = r.client_id
     WHERE pb.current_batch_id IN (${sql.join(
       batchIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
       AND pb.status = 'planned' AND pb.crate_id IS NULL
       AND EXISTS (
         SELECT 1 FROM boxes qb
          WHERE qb.lot_id = l.id AND qb.current_batch_id = pb.current_batch_id
            AND ${qrlessRowSql(sql`qb`, sql`l`)}
       )
       AND NOT EXISTS (
         SELECT 1 FROM scan_events cse JOIN boxes cb ON cb.id = cse.box_id
          WHERE cse.batch_id = pb.current_batch_id AND cse.crate_id IS NULL
            AND cse.manual_reason = ${COUNT_LOAD_REASON} AND cb.lot_id = l.id
       )
     ORDER BY l.letter
  `)) as unknown as {
    batch_id: string;
    lot_id: string;
    letter: string | null;
    marking: string | null;
    client_code: string | null;
  }[];
  for (const row of rows) {
    const label = `${codeIdentity(row.marking, row.client_code).main}-${row.letter ?? '?'}`;
    out.set(row.batch_id, [...(out.get(row.batch_id) ?? []), { lotId: row.lot_id, label }]);
  }
  return out;
}

/**
 * Who is told how a truck went: whoever plans them. Resolved from the
 * EDITABLE grants (#170), so a role the owner invents is included the day it
 * gets `plans.manage` — never a compiled list of role names.
 *
 * Cartons left behind are named by CODE — except a lot the office counts
 * (0112): nobody can find «GS777-00031» on a pile with no stickers, so such a
 * lot is one line, «GS777-A ×2».
 */
async function notifyLoadSummary(
  batchId: string,
  result: {
    batchCode: string;
    loaded: number;
    shortLoaded: number;
    shortLoadedCodes: string[];
    shortLoadedIds: string[];
    addedOnSpot: number;
  },
  actorId: string | null | undefined,
): Promise<void> {
  const userIds = await usersWithPermission('plans.manage');
  if (userIds.length === 0) return;
  const appUrl = process.env.APP_URL ?? '';
  const left = result.shortLoaded
    ? await shortLoadedLine(batchId, result.shortLoadedIds, result.shortLoadedCodes)
    : '';
  await notifyStaffTelegram({
    userIds,
    type: 'LoadFinished',
    exceptUserId: actorId ?? null,
    text:
      `🚚 ${result.batchCode} — yuklash tugadi\n` +
      `Yuklandi: ${result.loaded} karobka` +
      (result.shortLoaded ? `\n↩️ Qolib ketdi: ${result.shortLoaded} — ${left}` : '') +
      (result.addedOnSpot ? `\n⚠️ Qo‘shib yuklandi: ${result.addedOnSpot}` : '') +
      `\n${appUrl}/batches/${batchId}`,
  });
}

/**
 * «Qolib ketdi» as one line: a lot the office counts (counted on this truck,
 * or QR-siz) as `label ×n`, every other carton by its code, twelve codes at
 * most. After the commit, on the pool.
 */
export async function shortLoadedLine(batchId: string, ids: string[], codes: string[]): Promise<string> {
  if (ids.length === 0) return '';
  const rows = await db
    .select({
      shortCode: boxes.shortCode,
      lotId: boxes.lotId,
      letter: receiptLots.letter,
      marking: receipts.unclaimedMarking,
      clientCode: clients.clientCode,
      office: sql<boolean>`(
        ${countedOnTruckSql(batchId, sql`${receiptLots}.id`, 'load')}
        OR ${qrlessRowSql(sql`${boxes}`, sql`${receiptLots}`)}
      )`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(receiptLots.id, boxes.lotId))
    .innerJoin(receipts, eq(receipts.id, receiptLots.receiptId))
    .leftJoin(clients, eq(clients.id, receipts.clientId))
    .where(inArray(boxes.id, ids));
  if (rows.length === 0) return codes.slice(0, 12).join(', ');
  const byLot = new Map<string, { label: string; n: number }>();
  const plain: string[] = [];
  for (const row of rows) {
    if (!row.office) {
      plain.push(row.shortCode);
      continue;
    }
    const label = `${codeIdentity(row.marking, row.clientCode).main}-${row.letter ?? '?'}`;
    const entry = byLot.get(row.lotId) ?? { label, n: 0 };
    entry.n += 1;
    byLot.set(row.lotId, entry);
  }
  const lines = [...byLot.values()].map((lot) => `${lot.label} ×${lot.n}`);
  return [...lines, ...plain.sort().slice(0, 12)].join(', ');
}

/** Depart (logist/manager): loaded boxes and the batch go in_transit. */
export async function departBatch(batchId: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new ScanError('unauthenticated');
  const actorId = ctx.actorId;
  return db.transaction(async (tx) => {
    // One loading change at a time per truck (0112): a count press must
    // never read a truck this call is half-way through changing.
    await lockTruckLoading(tx, batchId);
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
