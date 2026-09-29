import { cache } from 'react';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import { z } from 'zod';
import { db, type Tx } from '../../platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clients,
  clientTransactions,
  costEntries,
  crates,
  driverDevices,
  loadPlans,
  receiptLots,
  receipts,
  scanEvents,
  warehouses,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { cancelTasksFor } from '../../platform/tasks/service';
import { emitEvent } from '../../platform/events/service';
import { claimArrivalNotice, releaseArrivalNotices } from '../notices/arrival';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { usersWithPermission } from '../../platform/notifications/service';
import { ScanError } from './service';
import { landedStatusFor } from '../warehouses/landed';
import { byShelf, shelfBefore } from '../boxes/shelf';
import { codeIdentity } from '../labels/code-identity';
import { doorOpens, type CountDoor } from './count-door';
import {
  BULK_ACCEPT_REASON,
  COUNT_ACCEPT_REASON,
  COUNT_OVER_REASON,
  countedOnTruckSql,
  isServerScanReason,
  lockLotOnTruck,
  lockTruckLoading,
  lotModeOnTruck,
  type DoorOpts,
} from './count-rules';

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
  /**
   * Crate members the record lists but this batch never carried (a member
   * short-loaded at the origin keeps its crateId). They are NOT accepted —
   * the crate label vouches for the crate, not for boxes nobody saw (#221's
   * asymmetry, closed on the unload side in round 31).
   */
  notArrived?: string[];
  /**
   * The code as it was scanned, on every REFUSAL.
   *
   * The phone marks a code done the moment it is scanned — right, because the
   * queue is the design and there is no network to ask. So every refusal has
   * to name what it refused, or the screen cannot take its own green mark
   * back off, and a truck flushed after «Tushirish tugadi» reads 150/150
   * while all 150 cartons are recorded as missing in transit.
   */
  scannedCode?: string;
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
  opts: DoorOpts = {},
): Promise<UnloadAck[]> {
  // Trucks a carton came off WITHOUT a load scan: that carton is their cargo
  // for money now (U25), so their costs re-split once the scans are in.
  const rogueTrucks = new Set<string>();
  // `finally`, because each input commits on its own: when a later input
  // throws (a deadlock between two phones, a bad row) the route answers 500
  // and the phone re-sends the batch — but the rogue landing before it has
  // already committed, and the retry answers that one as a replay.
  try {
    return await landUnloadScans(inputs, ctx, rogueTrucks, opts);
  } finally {
    // After every commit, never inside one (#714), and never failing the
    // scan. QUEUED, not run: the re-split covers every bill and grid cell on
    // the truck, which is seconds of the scanning phone's ack on a truck
    // with a real grid, and a job survives the restart a request does not
    // (`queueRiderChange`).
    if (rogueTrucks.size > 0) {
      try {
        const { queueRiderChange } = await import('../costing/service');
        await queueRiderChange([...rogueTrucks], 'undocumented_transfer');
      } catch (err) {
        console.error('[unload] rider re-split could not be arranged', [...rogueTrucks], err);
      }
    }
  }
}

/** `ingestUnloadScans`' walk — one transaction per input, rogue trucks noted. */
async function landUnloadScans(
  inputs: UnloadScanInput[],
  ctx: AuditContext,
  rogueTrucks: Set<string>,
  opts: DoorOpts,
): Promise<UnloadAck[]> {
  if (!ctx.actorId) throw new ScanError('unauthenticated');
  const actorId = ctx.actorId;
  const acks: UnloadAck[] = [];

  for (const input of inputs) {
    const ack = await db.transaction((tx) => landUnloadInput(tx, input, actorId, rogueTrucks, opts));
    acks.push(ack);
  }
  return acks;
}

/**
 * One unload input, inside the caller's transaction — the body the phone's
 * sync, «Hammasini qabul qilish» and the office's count door (0112) share, so
 * a counted carton lands exactly as a scanned one: movement, scan event,
 * crate, the client's arrival claim, rider money. `opts` is the door's; the
 * phone passes `{}`. A carton that landed as a rogue is noted in
 * `rogueTrucks` for the caller's re-split.
 */
export async function landUnloadInput(
  tx: Tx,
  input: UnloadScanInput,
  actorId: string,
  rogueTrucks: Set<string>,
  opts: DoorOpts,
): Promise<UnloadAck> {
  // A server door's reason on a scan that did not come through a server
  // door is a forgery (0112) — refused before the replay check and before
  // the arrival flip below, so a forged row can neither mark a lot counted
  // nor declare a truck arrived (#531).
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
  if (!batch) {
    return {
      clientEventUuid: input.clientEventUuid,
      result: 'rejected',
      detail: 'batch_not_found',
      scannedCode: input.code,
    };
  }
  if (!['in_transit', 'arrived'].includes(batch.status)) {
    return {
      clientEventUuid: input.clientEventUuid,
      result: 'rejected',
      detail: 'batch_not_unloading',
      scannedCode: input.code,
    };
  }

  const existing = await tx.query.scanEvents.findFirst({
    where: eq(scanEvents.clientEventUuid, input.clientEventUuid),
  });
  if (existing) {
    // A replayed rogue landing re-arms its truck's re-split: the first
    // attempt committed the landing and may have died before it queued
    // anything (a restart, a later input's throw) — the phone's retry is
    // then the only thing that still knows. A second queued re-split is
    // idempotent; a missing one leaves the carton $0 of its truck for good.
    if (existing.addedOnSpot) rogueTrucks.add(input.batchId);
    return { clientEventUuid: input.clientEventUuid, result: 'ok', detail: 'replay' };
  }

  // First scan marks arrival — conditional in the WHERE, not on the status
  // read at the top: a truck finished meanwhile must not be put back to
  // «arrived» by a phone's late scan (review of the fixes, lock-rv2-2).
  if (batch.status === 'in_transit') {
    await tx
      .update(batches)
      .set({ status: 'arrived', arrivedAt: new Date() })
      .where(and(eq(batches.id, input.batchId), eq(batches.status, 'in_transit')));
  }

  const isCrate = /^CR-/i.test(input.code);
  let members: (typeof boxes.$inferSelect)[] = [];
  let crateId: string | null = null;
  if (isCrate) {
    const crate = await tx.query.crates.findFirst({
      where: sql`upper(code) = ${input.code.toUpperCase()}`,
    });
    if (!crate) {
      return {
        clientEventUuid: input.clientEventUuid,
        result: 'unknown_code',
        scannedCode: input.code,
      };
    }
    crateId = crate.id;
    members = await tx.select().from(boxes).where(eq(boxes.crateId, crate.id)).for('update');
    if (members.length === 0) {
      return {
        clientEventUuid: input.clientEventUuid,
        result: 'unknown_code',
        detail: 'empty_crate',
        scannedCode: input.code,
      };
    }
  } else {
    // A count door names the carton it chose by primary key; the code it
    // posts must still be that carton's.
    const rows = opts.boxId
      ? await tx.select().from(boxes).where(eq(boxes.id, opts.boxId)).for('update')
      : await tx
          .select()
          .from(boxes)
          .where(sql`upper(${boxes.shortCode}) = ${input.code.toUpperCase()}`)
          .for('update');
    if (rows.length === 0) {
      return {
        clientEventUuid: input.clientEventUuid,
        result: 'unknown_code',
        scannedCode: input.code,
      };
    }
    if (opts.boxId && rows[0]!.shortCode.toUpperCase() !== input.code.toUpperCase()) {
      throw new ScanError('door_box_mismatch');
    }
    // Row, THEN the lot on this truck (0112): the office's count takes the
    // same lock after its rows, so a phone's first scan and a count press
    // cannot both decide «nobody has counted this lot yet».
    await lockLotOnTruck(tx, input.batchId, rows[0]!.lotId);
    members = rows;
  }

  // UZ side (spec 6.6): unloading at a customs/distribution warehouse puts
  // cargo straight into ready_for_pickup.
  const destWh = (await tx.query.warehouses.findFirst({
    where: eq(warehouses.id, batch.destWarehouseId),
  }))!;
  const landedStatus = landedStatusFor(destWh.type);

  // A crate scan vouches for the CRATE, not for every box its record
  // lists: a member short-loaded at the origin keeps its crateId, and the
  // fan-out used to "reality-wins" it here — the client was told cargo
  // arrived that is physically on a shelf in China, and Yiwu stock lost
  // the box. Reality-wins stays for a box somebody physically scanned by
  // its own label; left-behind members are NAMED, never moved.
  let notArrived: string[] = [];
  if (crateId) {
    const cameHere = (b: (typeof boxes.$inferSelect)) =>
      (b.currentBatchId === input.batchId && b.status === 'in_transit') ||
      (b.status === landedStatus && b.currentWarehouseId === batch.destWarehouseId);
    notArrived = members.filter((b) => !cameHere(b)).map((b) => b.shortCode);
    members = members.filter(cameHere);
    if (members.length === 0) {
      return {
        clientEventUuid: input.clientEventUuid,
        result: 'rejected',
        detail: 'crate_not_on_batch',
        scannedCode: input.code,
      };
    }
  }

  // Business duplicate: everything already landed at this destination.
  const allDone = members.every(
    (b) => b.status === landedStatus && b.currentWarehouseId === batch.destWarehouseId,
  );
  if (allDone) {
    return {
      clientEventUuid: input.clientEventUuid,
      result: 'duplicate',
      ...(notArrived.length ? { notArrived } : {}),
    };
  }

  for (const box of members) {
    if (['issued', 'void'].includes(box.status)) {
      return {
        clientEventUuid: input.clientEventUuid,
        result: 'rejected',
        detail: `box_${box.status}`,
        scannedCode: input.code,
      };
    }
  }

  // A lot the office counts is the office's on this truck (0112, Q4/Q8): a
  // lot counted at EITHER end of it — a sticker that fell off on the road
  // must not turn a load-counted lot into a scanned one here — or holding a
  // stickerless carton aboard. «Hammasini qabul qilish» is a door too: it
  // lands QR-siz and load-counted lots, and leaves a lot the office counted
  // HERE to the count. A crate is always scanned as the crate.
  if (!crateId && members[0]!.crateId === null && (!opts.door || opts.door === BULK_ACCEPT_REASON)) {
    const mode = await lotModeOnTruck(tx, {
      batchId: input.batchId,
      lotId: members[0]!.lotId,
      side: 'unload',
      countedSide: opts.door ? 'unload' : 'any',
      quickOriginId: null,
    });
    if (mode === 'counted' || (mode === 'qrless' && !opts.door)) {
      return {
        clientEventUuid: input.clientEventUuid,
        result: 'rejected',
        detail: mode === 'counted' ? 'lot_counted' : 'qr_less_count_only',
        scannedCode: input.code,
      };
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
  // Landing also retires the JOURNEY flags — added_on_spot and
  // missing_in_transit describe one trip, and a box that kept them was
  // printing last truck's deviations on the next truck's manifest.
  for (const box of toMove) {
    const isRogue = rogue.includes(box);
    await tx
      .update(boxes)
      .set({
        status: landedStatus,
        currentWarehouseId: batch.destWarehouseId,
        currentBatchId: null,
        statusReason: null,
        // An office count of cartons BEYOND the manifest (`count_over`)
        // is a stated fact with a written reason, not a mystery — it rides
        // as the truck's cargo for money like any rogue carton, but carries
        // no flag the risk list would chase for ever (0112).
        ...(isRogue
          ? {
              crateId: crateId ?? null,
              flags: opts.door === COUNT_OVER_REASON ? [] : ['undocumented_transfer'],
            }
          : { flags: [] }),
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

  // The crate row's warehouse follows its landed boxes. Frozen at the
  // origin, an arrived yashik could neither be planned onward from here
  // nor counted at inventory where it really stands.
  const landedCrateIds = [
    ...new Set([...toMove.map((b) => b.crateId), crateId].filter((id): id is string => !!id)),
  ];
  if (landedCrateIds.length) {
    await tx
      .update(crates)
      .set({ warehouseId: batch.destWarehouseId })
      .where(and(inArray(crates.id, landedCrateIds), eq(crates.status, 'active')));
  }

  /*
   * Client arrival summary (spec 6.6) — and the owner's report, round 98:
   * «mashinadan yuk tushganda yukingiz keldi deb har bir karobka uchun
   * habar jonatyabti».
   *
   * This block runs inside the per-SCAN transaction, so it used to emit
   * `ReadyForPickup` once for every carton the phone sent — and
   * `unloadRemaining` feeds one input per short code through this same
   * door, so one press of «accept the rest» could send a customer two
   * hundred messages.
   *
   * Round 98 moved the CLIENT's copy onto a claim and left the event
   * here, «for the staff side, which is what it was written for». The
   * owner's next report was the other half of the same sentence: «10 ta
   * karobka kelsa 10 ta sms» — his SELLER was getting one Telegram per
   * carton. So the event went with it (`notices/arrival-staff.ts`): one
   * per customer per truck, with the totals as they really are, carrying
   * the deal's cargo trigger and the automation rules with it.
   *
   * What stays HERE is the claim, and only the claim. Inside this
   * transaction on purpose: a claim that survived a rolled-back unload
   * would silence the real one that follows, and a claim made in the
   * worker could not know which scan was first.
   */
  if (landedStatus === 'ready_for_pickup' && toMove.length > 0) {
    const lotRows = await tx
      .select({ lotId: receiptLots.id, clientId: receipts.clientId })
      .from(receiptLots)
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .where(inArray(receiptLots.id, [...new Set(toMove.map((b) => b.lotId))]));
    const clientByLot = new Map(lotRows.map((r) => [r.lotId, r.clientId]));
    const landedClients = new Set<string>();
    for (const box of toMove) {
      const cid = clientByLot.get(box.lotId);
      if (cid) landedClients.add(cid);
    }
    for (const cid of landedClients) {
      await claimArrivalNotice(tx, cid, input.batchId, {
        actorId,
        windowMinutes: opts.noticeWindowMinutes,
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

  // A count door sends ONE alarm for its whole press, not one per carton.
  if (rogue.length > 0 && !opts.quietSpot) {
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
  // Only a rogue carton this scan MOVED changes the truck's riders: a
  // crate re-scan whose members already landed singly names them rogue
  // too, and re-split the truck for nothing.
  if (toMove.some((box) => rogue.includes(box))) rogueTrucks.add(input.batchId);
  return {
    clientEventUuid: input.clientEventUuid,
    result: onManifest ? 'ok' : 'auto_transfer',
    boxes: letters,
    ...(notArrived.length ? { notArrived } : {}),
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
 * Boxes that travelled with this batch — INCLUDING the ones already accepted
 * at the destination.
 *
 * Accepting a box clears its `current_batch_id`, so a plain
 * `current_batch_id = batch` filter loses it at exactly the moment it matters:
 * the unload screen's counter went down instead of up, and a page reload
 * showed nothing had been accepted at all. What departed is written to
 * box_movements once and never changes.
 *
 * Written as the UNION of the two indexed lookups, never as `pointer OR
 * EXISTS(…)` (#152, riders.ts's own rule). The OR form answered the same set
 * by reading EVERY box ever received and probing each: measured on a 120k-box
 * copy, 79-95 ms per call with JIT off and 280-590 ms with it on — and the
 * truck card asks this on every tab. As a UNION it is two index lookups
 * (1.3 ms). The outer box is also named OUTSIDE the subquery now, so a
 * one-table select — where drizzle writes the column bare — can no longer
 * bind it to the subquery's own table (#128).
 */
export function batchMemberFilter(batchId: string) {
  return sql`${boxes.id} IN (
    SELECT bmf_b.id FROM boxes bmf_b WHERE bmf_b.current_batch_id = ${batchId}
    UNION
    SELECT bmf_m.box_id FROM box_movements bmf_m
     WHERE bmf_m.ref_type = 'batch' AND bmf_m.ref_id = ${batchId} AND bmf_m.cause = 'batch_departed'
  )`;
}

/**
 * The cargo that is really ON (or came off) this truck: a member that is not
 * merely reserved. Before 0112 a load scan event was as good as this, because
 * nothing took a scanned carton back off quietly; an office count can dial a
 * lot down, so the customs papers and the register read the cartons, and the
 * scan events only annotate them.
 *
 * «Merely reserved» is a fact about the LIVE pointer only: a carton that rode
 * this truck, landed at a hub and was planned onto the NEXT truck is
 * `planned` again, and reading the status on the departure branch too emptied
 * this truck's packing list, TNVED page and register ➕ until the next truck
 * started loading — a document changing its claims on re-download
 * (review cargo-1, round 92's rule).
 *
 * The UNION of two index lookups, for `batchMemberFilter`'s reason above.
 */
export function aboardFilter(batchId: string) {
  return sql`${boxes.id} IN (
    SELECT abf_b.id FROM boxes abf_b
     WHERE abf_b.current_batch_id = ${batchId} AND abf_b.status <> 'planned'
    UNION
    SELECT abf_m.box_id FROM box_movements abf_m
     WHERE abf_m.ref_type = 'batch' AND abf_m.ref_id = ${batchId} AND abf_m.cause = 'batch_departed'
  )`;
}

/**
 * «Still on the truck»: the live pointer names it and the box has not landed.
 *
 * The LIVE pointer on purpose, the opposite of `batchMemberFilter`: this is
 * the question «what is left to scan off», and landing clears exactly the
 * pointer this reads. One fragment for the unload screen's counter and the
 * dashboard's per-truck count, so «N karobka tushirilmagan» on the owner's
 * screen is the number the operator's screen is counting down (#513).
 */
function awaitingUnloadWhere(batchIds: string[]) {
  return and(inArray(boxes.currentBatchId, batchIds), eq(boxes.status, 'in_transit'));
}

/**
 * The cartons `finishUnload` flagged as lost on the road and nobody has
 * resolved yet — still pointing at THIS truck. ONE read for the truck card's
 * header («Yo'lda yo'qolganlar · N») and the resolution list on its
 * «Tushirish» tab, so the count on the header is the list below it.
 */
export const batchMissingBoxes = cache(async function batchMissingBoxes(batchId: string) {
  return db
    .select({
      box: boxes,
      letter: receiptLots.letter,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
      product: receiptLots.productNameZh,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(sql`${boxes.currentBatchId} = ${batchId} AND ${boxes.flags} @> '["missing_in_transit"]'::jsonb`);
});

/** How many manifest boxes are still waiting to be accepted here. */
export const remainingToUnload = cache(async function remainingToUnload(batchId: string): Promise<string[]> {
  const rows = await db
    .select({ shortCode: boxes.shortCode })
    .from(boxes)
    .where(awaitingUnloadWhere([batchId]))
    .orderBy(boxes.shortCode);
  return rows.map((r) => r.shortCode);
});

/**
 * `remainingToUnload(id).length` for many trucks in ONE grouped statement —
 * the dashboard asks about every truck standing at a gate, and one query per
 * truck is a list screen's cost growing with the fleet (#432). A truck with
 * nothing left is ABSENT from the map; the caller reads that as 0.
 */
export async function awaitingUnloadCounts(batchIds: string[]): Promise<Map<string, number>> {
  if (batchIds.length === 0) return new Map();
  const rows = await db
    .select({ batchId: boxes.currentBatchId, n: sql<number>`count(*)` })
    .from(boxes)
    .where(awaitingUnloadWhere(batchIds))
    .groupBy(boxes.currentBatchId);
  return new Map(rows.flatMap((r) => (r.batchId ? [[r.batchId, Number(r.n)] as const] : [])));
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

  // A lot the office counted HERE is the count's (0112, decision 21): its
  // loose cartons still aboard are the count's declared shortfall, not
  // «everything else». Left out up front by the same sentence the phone is
  // refused with, so the button's number, the audit and what lands agree —
  // the shared body would refuse them anyway, one input at a time. Crated
  // members still land: a crate is scanned as the crate, never counted.
  const aboard = await db
    .select({
      shortCode: boxes.shortCode,
      counted: sql<boolean>`(${boxes}.crate_id IS NULL AND ${countedOnTruckSql(batchId, sql`${boxes}.lot_id`, 'unload')})`,
    })
    .from(boxes)
    .where(awaitingUnloadWhere([batchId]))
    .orderBy(boxes.shortCode);
  const remaining = aboard.filter((row) => !row.counted).map((row) => row.shortCode);
  let skippedCounted = aboard.length - remaining.length;
  if (remaining.length === 0) return { accepted: 0, skippedCounted };

  const scannedAt = new Date().toISOString();
  const acks = await ingestUnloadScans(
    remaining.map((shortCode) => ({
      // Derived from the batch, so pressing the button twice replays instead
      // of writing a second scan event.
      clientEventUuid: uuidv5(`bulk:${shortCode}`, batchId),
      batchId,
      code: shortCode,
      method: 'manual' as const,
      manualReason: BULK_ACCEPT_REASON,
      scannedAt,
    })),
    ctx,
    // A server door (0112): only through one may a scan carry a server reason.
    { door: BULK_ACCEPT_REASON },
  );
  // What actually landed, not what was asked for: a lot the office counted
  // between the read above and its input is refused by the body, and the
  // record must say so rather than list it as accepted.
  const landed = remaining.filter((_, i) => ['ok', 'auto_transfer'].includes(acks[i]?.result ?? ''));
  skippedCounted += acks.filter((a) => a.result === 'rejected' && a.detail === 'lot_counted').length;
  const accepted = landed.length;
  await writeAudit(db, { ...ctx, warehouseId: batch.destWarehouseId }, {
    entityType: 'batch',
    entityId: batchId,
    action: 'update',
    after: { bulkUnload: accepted, shortCodes: landed, skippedCounted },
  });
  return { accepted, skippedCounted };
}

/**
 * Finish unload (spec 6.5): manifest boxes never scanned here stay
 * `in_transit` flagged `missing_in_transit` + alert; batch → `unloaded`.
 */
export async function finishUnload(
  batchId: string,
  ctx: AuditContext,
  opts: { mayCloseWithMissing?: boolean } = {},
) {
  if (!ctx.actorId) throw new ScanError('unauthenticated');
  const actorId = ctx.actorId;
  return db.transaction(async (tx) => {
    // The truck row BEFORE the cartons, as a phone's first scan and the
    // office's count both take it; cartons first closed a cycle with a count
    // press starting at the same moment (review lock-4).
    const [batch] = await tx.select().from(batches).where(eq(batches.id, batchId)).for('no key update');
    if (!batch) throw new ScanError('batch_not_found');
    if (!['in_transit', 'arrived'].includes(batch.status)) throw new ScanError('batch_not_unloading');

    const missing = await tx
      .select()
      .from(boxes)
      .where(sql`${boxes.currentBatchId} = ${batchId} AND ${boxes.status} = 'in_transit'`)
      .for('update');
    /*
     * Closing over outstanding cartons is not bookkeeping — it DECLARES THEM
     * LOST, flags every one `missing_in_transit`, and the client's handover
     * then refuses until a manager resolves each. The owner took the
     * accept-everything shortcut away from the operators so the cartons get
     * scanned; leaving them this one would simply move the same press one
     * button to the right, and lose the cargo instead of accepting it.
     *
     * Refused in the SERVICE and not only on the screen (#531). `opts`
     * defaults to false, so a caller that forgets the question gets the safe
     * answer — and the plain close, with nothing outstanding, is untouched
     * and stays the unloader's own.
     */
    if (missing.length > 0 && !opts.mayCloseWithMissing) {
      throw new ScanError('finish_needs_manager');
    }
    // Per lot as well as per code (0112): a lot the office counted short
    // has no sticker on its missing cartons, so a list of codes names
    // nothing anybody can look for — «GS777-A · kurtka: 2» does. Additive:
    // the codes stay, and an old event renders them as it always did (#688).
    let missingLots: MissingLotLine[] = [];
    if (missing.length > 0) {
      missingLots = await missingLotLines(tx, missing);
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
          lots: missingLots,
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
    // Declared in the event list (and offered as a rule trigger) since M4,
    // but never actually emitted until round 26 needed «mashina tushirildi»
    // to move the deal funnel. Any automation rule the owner had already
    // pointed at BatchUnloaded starts firing with this line.
    await emitEvent(tx, {
      type: 'BatchUnloaded',
      payload: {
        batchId,
        batchCode: batch.code,
        warehouseId: batch.destWarehouseId,
        missing: missing.length,
      },
      entityType: 'batch',
      entityId: batchId,
      actorId,
    });
    await writeAudit(tx, { ...ctx, warehouseId: batch.destWarehouseId }, {
      entityType: 'batch',
      entityId: batchId,
      action: 'status_change',
      after: { status: 'unloaded', missing: missing.length },
    });
    // The truck is closed, so the clients waiting for their «yukingiz keldi»
    // have nothing left to wait for. The window in `claimArrivalNotice` is a
    // CEILING for the warehouse that never presses this button, not a delay
    // this one has to serve out.
    await releaseArrivalNotices(tx, batchId);
    const accepted = await tx
      .select({ n: sql<number>`count(DISTINCT box_id)` })
      .from(sql`box_movements bm`)
      .where(
        sql`bm.ref_type = 'batch' AND bm.ref_id = ${batchId} AND bm.cause IN ('unload_scan', 'undocumented_transfer')`,
      );
    return {
      batch: updated!,
      missing: missing.map((b) => b.shortCode),
      missingLots,
      accepted: Number(accepted[0]?.n ?? 0),
    };
  }).then(async (result) => {
    // The unload summary (staff bot, owner's item 6) — same shape and same
    // rule as the loading one: after the transaction, never to the presser.
    await notifyUnloadSummary(batchId, result, ctx.actorId).catch(() => {});
    return { batch: result.batch, missing: result.missing, missingLots: result.missingLots };
  });
}

/** One lot's missing cartons, the way a person says it: «GS777-A · kurtka: 2». */
export interface MissingLotLine {
  label: string;
  product: string;
  n: number;
}

/** The finish's missing cartons grouped by lot — one read, inside its transaction. */
async function missingLotLines(
  tx: Tx,
  missing: { lotId: string }[],
): Promise<MissingLotLine[]> {
  const counts = new Map<string, number>();
  for (const box of missing) counts.set(box.lotId, (counts.get(box.lotId) ?? 0) + 1);
  const rows = await tx
    .select({
      id: receiptLots.id,
      letter: receiptLots.letter,
      product: receiptLots.productNameZh,
      productRu: receiptLots.productNameRu,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
    })
    .from(receiptLots)
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(inArray(receiptLots.id, [...counts.keys()]));
  return rows
    .map((r) => ({
      label: `${codeIdentity(r.marking, r.clientCode).main}-${r.letter ?? '?'}`,
      // Russian first, as every count alarm names a lot (review ui-6).
      product: r.productRu || r.product,
      n: counts.get(r.id) ?? 0,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function notifyUnloadSummary(
  batchId: string,
  result: { batch: { code: string }; missing: string[]; missingLots: MissingLotLine[]; accepted: number },
  actorId: string | null | undefined,
): Promise<void> {
  const userIds = await usersWithPermission('plans.manage');
  if (userIds.length === 0) return;
  const appUrl = process.env.APP_URL ?? '';
  // Per lot (0112): a carton the office counted short carries no sticker, so
  // its code names nothing on the floor; the lot does.
  const lots = result.missingLots;
  const missingLine = lots.length
    ? `\n🔍 Yetib kelmadi: ${result.missing.length} — ${lots
        .slice(0, 12)
        .map((l) => `${l.label}: ${l.n}`)
        .join(', ')}${lots.length > 12 ? ` (+${lots.length - 12} lot)` : ''}`
    : result.missing.length
      ? `\n🔍 Yetib kelmadi: ${result.missing.length} — ${result.missing.slice(0, 12).join(', ')}`
      : '';
  await notifyStaffTelegram({
    userIds,
    type: 'UnloadFinished',
    exceptUserId: actorId ?? null,
    text:
      `📥 ${result.batch.code} — tushirish tugadi\n` +
      `Qabul qilindi: ${result.accepted} karobka` +
      missingLine +
      `\n${appUrl}/batches/${batchId}`,
  });
}

/**
 * The two «found» answers carry nothing but the box; the third — the carton
 * is gone, lost on the road — carries a person's written reason, like every
 * other write-off (`markBoxLost`, the box card). A discriminated union so the
 * found buttons stay reason-free and a loss cannot be declared without one.
 */
export const resolveMissingSchema = z.discriminatedUnion('resolution', [
  z.object({ boxId: z.string().uuid(), resolution: z.literal('found_at_origin') }),
  z.object({ boxId: z.string().uuid(), resolution: z.literal('found_here') }),
  z.object({
    boxId: z.string().uuid(),
    resolution: z.literal('lost_in_transit'),
    reason: z.string().trim().min(3).max(500),
  }),
]);

/**
 * Resolve a missing-in-transit box (spec 6.5 resolution actions).
 *
 * `lost_in_transit` is the honest end a carton the truck arrived without
 * never had (U38). Both older answers say it was FOUND — here, or back in
 * China — and every door to `lost` (markBoxLost, the box card, the
 * stocktake) needs a box standing on a shelf at a warehouse, which a departed
 * box has neither of. So until somebody lied, the carton stayed «missing» for
 * ever: on /transit, on the client card as «transit», in the cabinet as «in
 * Uzbekistan», and its deal could never read «to'liq topshirildi». The lie
 * cost too: «found here» then «lost» wrote a false arrival into the ledger
 * and could send the client a «yukingiz keldi» for a carton nobody has.
 *
 * The box becomes `lost` in NO warehouse — it is in none — with the written
 * reason, off its truck and out of its crate (markBoxLost's rule: a lost
 * member jams its crate), and a movement row naming the truck. No arrival
 * notice: nothing arrived. The MONEY does not move (owner, 6a): the lost
 * carton keeps its freight share in the client's tannarx, and the loss is
 * shown beside the P&L as information (`lossesInPeriod`), never subtracted.
 */
export async function resolveMissing(
  input: z.infer<typeof resolveMissingSchema>,
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new ScanError('unauthenticated');
  const actorId = ctx.actorId;
  // The schema says it for the form; the service says it again for every
  // other caller (#531).
  const lossReason = input.resolution === 'lost_in_transit' ? input.reason.trim() : null;
  if (input.resolution === 'lost_in_transit' && (!lossReason || lossReason.length < 3)) {
    throw new ScanError('reason_required');
  }
  const result = await db.transaction(async (tx) => {
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

    return resolveOneMissingInTx(tx, box, batch, { resolution: input.resolution, reason: lossReason }, ctx);
  });

  // Found at the ORIGIN, the carton never rode this truck: its share of the
  // truck's road costs goes back to the cargo that did (DECISIONS #15, U17).
  // In the SERVICE, so no door can forget it (#531); after the commit (#714).
  // A carton lost ON the road did ride it and keeps its share (owner, 6a).
  if (result.resolution === 'found_at_origin') {
    const { recomputeRiderChange } = await import('../costing/service');
    await recomputeRiderChange([result.batchId], 'found_at_origin');
  }

  // The loss can be the deal's last outstanding carton — the rest handed over
  // before anybody gave up on this one — and then the deal is fully handed
  // and must say so; the funnel's own ear hears only a handover (U38).
  // After the commit, and never able to fail the door that recorded the loss.
  if (result.loss) {
    try {
      const { advanceDealsAfterWriteOff } = await import('../deals/auto-stage');
      await advanceDealsAfterWriteOff([input.boxId], ctx);
    } catch (error) {
      console.error('[unload] deal stage after a road loss failed', input.boxId, error);
    }
  }

  // The seller (compensation is their conversation) and whoever plans the
  // trucks, in ONE message each to a union — markBoxLost's recipients and its
  // reasons, after the commit and never to the presser.
  if (result.loss) {
    const { reason, batchCode, about } = result.loss;
    const userIds = [
      ...(about?.salesManagerId ? [about.salesManagerId] : []),
      ...(await usersWithPermission('plans.manage')),
    ];
    if (userIds.length > 0) {
      await notifyStaffTelegram({
        userIds,
        type: 'BoxLost',
        exceptUserId: actorId,
        text:
          `❌ ${result.shortCode} (${about?.clientCode ?? '?'}-${about?.letter ?? ''}, ${about?.product ?? ''}) ` +
          `${batchCode} reysida yo'lda yo'qoldi.\nSabab: ${reason}`,
      }).catch(() => {});
    }
  }
  return { shortCode: result.shortCode, resolution: result.resolution };
}

/**
 * The per-LOT answer to «where are the missing cartons» (0112, decision 22).
 * A lot counted short has no sticker on its missing cartons: a list of codes
 * nobody can read off a carton is no list, so the office answers by the lot
 * and a number — «3 of GS777-A are here».
 */
const missingLotBase = {
  batchId: z.string().uuid(),
  lotId: z.string().uuid(),
  n: z.coerce.number().int().min(1).max(10_000),
  /** How many the person SAW missing — a list that moved since is refused (#1135). */
  seenMissing: z.coerce.number().int().min(1).max(10_000),
};
export const resolveMissingLotSchema = z.discriminatedUnion('resolution', [
  z.object({ ...missingLotBase, resolution: z.literal('found_here') }),
  z.object({ ...missingLotBase, resolution: z.literal('found_at_origin') }),
  z.object({
    ...missingLotBase,
    resolution: z.literal('lost_in_transit'),
    reason: z.string().trim().min(3).max(500),
  }),
]);
export type ResolveMissingLotInput = z.infer<typeof resolveMissingLotSchema>;

/**
 * Resolve N of one lot's missing cartons at once, through the very body the
 * per-box buttons run (`resolveOneMissingInTx`) — same movement, same audit,
 * same arrival claim per carton. A typed N moves cargo with no per-carton
 * witness, so it is a COUNT (the owner's Q3a): the destination's count door,
 * asked here in the service (#531), never the per-box `receipts.void`. The
 * after-commit work runs ONCE per press: one rider re-split, one deal pass,
 * one BoxLost message — not one per carton (round 98's complaint).
 */
export async function resolveMissingLot(
  input: ResolveMissingLotInput,
  ctx: AuditContext,
  dest: CountDoor | null,
): Promise<{ resolved: number; resolution: ResolveMissingLotInput['resolution']; shortCodes: string[] }> {
  if (!ctx.actorId) throw new ScanError('unauthenticated');
  const actorId = ctx.actorId;
  const pre = await db.query.batches.findFirst({ where: eq(batches.id, input.batchId) });
  if (!pre) throw new ScanError('batch_not_found');
  if (!doorOpens(dest, pre.destWarehouseId, actorId)) throw new ScanError('forbidden');
  const lossReason = input.resolution === 'lost_in_transit' ? input.reason.trim() : null;
  if (input.resolution === 'lost_in_transit' && (!lossReason || lossReason.length < 3)) {
    throw new ScanError('reason_required');
  }
  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(boxes)
      .where(
        and(
          eq(boxes.currentBatchId, input.batchId),
          eq(boxes.lotId, input.lotId),
          isNull(boxes.crateId),
          sql`${boxes.flags} @> '["missing_in_transit"]'::jsonb`,
        ),
      )
      .orderBy(boxes.seqInLot, boxes.id)
      .for('update');
    if (rows.length !== input.seenMissing) throw new ScanError('count_stale');
    if (input.n > rows.length) throw new ScanError('resolve_exceeds_missing');
    const batch = (await tx.query.batches.findFirst({ where: eq(batches.id, input.batchId) }))!;
    const done: ResolvedMissing[] = [];
    for (const box of rows.slice(0, input.n)) {
      done.push(
        await resolveOneMissingInTx(tx, box, batch, { resolution: input.resolution, reason: lossReason }, ctx),
      );
    }
    // A typed N has no per-carton witness: which cartons «are» the N is the
    // lowest numbers' guess, and a stocktake must not write them off for not
    // being scanned (decision 33). The per-box buttons are witnessed and write
    // no such event (review phone-1).
    const placed = rows.slice(0, input.n).filter(() => input.resolution !== 'lost_in_transit');
    if (placed.length > 0) {
      const at = new Date();
      await tx.insert(scanEvents).values(
        placed.map((box) => ({
          clientEventUuid: uuidv4(),
          boxId: box.id,
          batchId: batch.id,
          type: 'unload',
          method: 'manual',
          manualReason: COUNT_ACCEPT_REASON,
          addedOnSpot: false,
          scannedBy: actorId,
          scannedAt: at,
        })),
      );
    }
    const [lot] = await missingLotLines(tx, rows.slice(0, input.n));
    await writeAudit(tx, { ...ctx, warehouseId: batch.destWarehouseId }, {
      entityType: 'batch',
      entityId: batch.id,
      action: 'update',
      after: {
        missingLotResolved: {
          lotId: input.lotId,
          lot: lot?.label ?? null,
          resolution: input.resolution,
          n: done.length,
          reason: lossReason,
          shortCodes: done.map((d) => d.shortCode),
        },
      },
    });
    return { done, batch, lot, ids: rows.slice(0, input.n).map((b) => b.id) };
  });

  const lostIds = input.resolution === 'lost_in_transit' ? result.ids : [];
  if (input.resolution === 'found_at_origin' && result.done.length > 0) {
    const { recomputeRiderChange } = await import('../costing/service');
    await recomputeRiderChange([input.batchId], 'found_at_origin');
  }
  if (lostIds.length > 0) {
    try {
      const { advanceDealsAfterWriteOff } = await import('../deals/auto-stage');
      await advanceDealsAfterWriteOff(lostIds, ctx);
    } catch (error) {
      console.error('[unload] deal stage after a road loss failed', lostIds, error);
    }
    const about = result.done[0]?.loss?.about ?? null;
    const userIds = [
      ...(about?.salesManagerId ? [about.salesManagerId] : []),
      ...(await usersWithPermission('plans.manage')),
    ];
    if (userIds.length > 0) {
      await notifyStaffTelegram({
        userIds,
        type: 'BoxLost',
        exceptUserId: actorId,
        text:
          `❌ ${result.lot?.label ?? '?'} (${about?.product ?? ''}) · ${lostIds.length} karobka · ` +
          `${result.batch.code} reysida yo‘lda yo‘qoldi.\nSabab: ${lossReason}`,
      }).catch(() => {});
    }
  }
  return {
    resolved: result.done.length,
    resolution: input.resolution,
    shortCodes: result.done.map((d) => d.shortCode),
  };
}

/** What one resolved carton leaves for the caller's after-commit work. */
interface ResolvedMissing {
  shortCode: string;
  resolution: 'found_at_origin' | 'found_here' | 'lost_in_transit';
  batchId: string;
  loss: {
    reason: string;
    batchCode: string;
    about: {
      clientCode: string | null;
      salesManagerId: string | null;
      product: string;
      letter: string | null;
    } | null;
  } | null;
}

/**
 * One missing carton's resolution, inside the caller's transaction, the box
 * row already locked and checked — the body the per-box buttons and the
 * office's per-lot door (0112, `resolveMissingLot`) share, so a carton
 * resolved as one of N writes exactly the movement, the audit and the
 * arrival claim a carton resolved alone does.
 */
async function resolveOneMissingInTx(
  tx: Tx,
  box: typeof boxes.$inferSelect,
  batch: typeof batches.$inferSelect,
  a: { resolution: ResolvedMissing['resolution']; reason: string | null },
  ctx: AuditContext,
): Promise<ResolvedMissing> {
  const actorId = ctx.actorId!;
  const flags = Array.isArray(box.flags) ? (box.flags as string[]) : [];
  if (a.resolution === 'lost_in_transit') {
    const reason = a.reason!;
    const [about] = await tx
      .select({
        clientCode: clients.clientCode,
        salesManagerId: clients.salesManagerId,
        product: receiptLots.productNameZh,
        letter: receiptLots.letter,
      })
      .from(receiptLots)
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .leftJoin(clients, eq(receipts.clientId, clients.id))
      .where(eq(receiptLots.id, box.lotId));
    await tx
      .update(boxes)
      .set({
        status: 'lost',
        statusReason: reason,
        flags: [],
        currentBatchId: null,
        currentWarehouseId: null,
        crateId: null,
      })
      .where(eq(boxes.id, box.id));
    await tx.insert(boxMovements).values({
      boxId: box.id,
      fromWarehouseId: null,
      toWarehouseId: null,
      fromStatus: box.status,
      toStatus: 'lost',
      cause: 'lost_in_transit',
      refType: 'batch',
      refId: batch.id,
      actorId,
    });
    await writeAudit(tx, { ...ctx, warehouseId: batch.destWarehouseId }, {
      entityType: 'box',
      entityId: box.id,
      action: 'status_change',
      // WHICH crate it was in and WHICH truck it rode, on the row that
      // records the loss — both pointers are cleared by it.
      before: { status: box.status, flags, crateId: box.crateId, batchId: batch.id },
      after: { status: 'lost', resolution: a.resolution, reason, shortCode: box.shortCode },
    });
    return {
      shortCode: box.shortCode,
      resolution: a.resolution,
      batchId: batch.id,
      loss: { reason, batchCode: batch.code, about: about ?? null },
    };
  }

  const foundHere = a.resolution === 'found_here';
  const targetWh = foundHere ? batch.destWarehouseId : batch.originWarehouseId;
  // A box found at the destination has to land exactly where a scanned one
  // lands, or it would sit in `in_stock` at a customs/distribution warehouse
  // and never show up as ready for the client.
  const targetWhRow = (await tx.query.warehouses.findFirst({
    where: eq(warehouses.id, targetWh),
  }))!;
  // Found at the ORIGIN is a box that never arrived — it goes back on the
  // shelf it left, as it stood there (`shelfBefore`: «tayyor» at Andijan is
  // «tayyor» again), and only a box found HERE lands by the destination's own
  // rule.
  const landedStatus = foundHere
    ? landedStatusFor(targetWhRow.type)
    : ((await shelfBefore(tx, batch.id, [box.id])).get(box.id) ?? 'in_stock');

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
    cause: a.resolution,
    refType: 'batch',
    refId: batch.id,
    actorId,
  });
  await writeAudit(tx, { ...ctx, warehouseId: targetWh }, {
    entityType: 'box',
    entityId: box.id,
    action: 'status_change',
    after: { resolution: a.resolution, shortCode: box.shortCode },
  });
  /*
   * A box found HERE has arrived, and until now this door said so to
   * nobody: no claim, no event — so the customer was never told and neither
   * was their seller. It mattered little while it was the rare tail of a
   * missing-box flow; it matters now that finishing over outstanding
   * cartons is a manager act and this is the ordinary way they come back.
   */
  if (foundHere && landedStatus === 'ready_for_pickup') {
    const [owner] = await tx
      .select({ clientId: receipts.clientId })
      .from(receiptLots)
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .where(eq(receiptLots.id, box.lotId));
    if (owner?.clientId) {
      await claimArrivalNotice(tx, owner.clientId, batch.id, { actorId });
    }
  }
  return { shortCode: box.shortCode, resolution: a.resolution, batchId: batch.id, loss: null };
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
    // One loading change at a time per truck (0112): a count press must not
    // re-reserve cartons onto a truck this cancel is giving back to stock.
    await lockTruckLoading(tx, batchId);
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

    // The same shape `finishLoading` writes for a short-loaded box: the
    // cargo goes back to the shelf it never left, as it stood there
    // (`shelfBefore`), and the movement says why.
    const back = await shelfBefore(tx, batchId, memberBoxes.map((b) => b.id));
    for (const [status, home] of byShelf(memberBoxes, back)) {
      await tx
        .update(boxes)
        // The journey is over: an on-spot flag picked up on this batch must
        // not ride into the box's next life on the shelf.
        .set({ status, currentBatchId: null, flags: [] })
        .where(inArray(boxes.id, home.map((b) => b.id)));
      await tx.insert(boxMovements).values(
        home.map((box) => ({
          boxId: box.id,
          fromWarehouseId: box.currentWarehouseId,
          toWarehouseId: box.currentWarehouseId,
          fromStatus: box.status,
          toStatus: status,
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
    // The pair code goes, so a screenshot of it is worthless — but the token
    // hash STAYS. A device the ingest cannot find at all is indistinguishable
    // from a bogus token and answers 401, which the Android client treats as a
    // server hiccup and retries for ever into an uncapped queue. Kept
    // findable, it answers 410 and the phone stops the service and forgets
    // the trip, which is what revoking is for.
    await tx
      .update(driverDevices)
      .set({ revokedAt: new Date(), pairCode: null })
      .where(and(eq(driverDevices.batchId, batchId), isNull(driverDevices.revokedAt)));

    // Open work raised ON this batch goes with it. Without this the task
    // stays on somebody's day and its link opens a trip that is over — the
    // step every other retirement in this system takes (`cancelTasksFor`).
    // Note the spelling: tasks and custom fields use 'batch', while the audit
    // log and the event stream use the same word but plans differ ('plan' vs
    // 'load_plan'), so a cleanup that knows one spelling misses half the rows.
    await cancelTasksFor(tx, 'batch', [batchId]);

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
