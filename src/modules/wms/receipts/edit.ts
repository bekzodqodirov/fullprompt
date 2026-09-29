import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Db, type Tx } from '../../platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clients,
  costEntries,
  crates,
  receiptLots,
  receipts,
  warehouses,
} from '../../platform/db/schema';
import { diffFields, writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';
import { getSetting } from '../../platform/settings/service';
import type { Actor } from '../../platform/rbac/authorize';
import { inScope } from '../../platform/rbac/scope';
import { nextBoxCodes } from '../codes';
import { costOrphanedByVoid, lockCostsTouchingLots } from '../costing/void-guard';
import { receiptHasCompensation } from '../finance/compensation-follow';
import { claimReceivedNotice } from '../notices/client-claims';
import { qrlessBoxSql } from '../labels/qrless-sql';
import { computeLotTotals } from './math';
import { factoryBarcodeKey } from './factory-barcode';
import { isOwnCodeShape } from '@/offline/code-shape';
import { receivedAtFor, receivedDayRefusal, type ReceivedDayRefusal } from './received-day';
import { checkReceiver, ReceiptError, receivedBySchema } from './service';
import { mayCountMove } from '../scanning/count-door';
import { dayIn } from '../../platform/time/tashkent';
import { stampFor } from '../staff/stamp';

export const editLotSchema = z.object({
  lotId: z.string().uuid(),
  productNameZh: z.string().trim().min(1).max(300),
  productNameRu: z.string().trim().max(300).optional().or(z.literal('')),
  boxCount: z.number().int().min(1).max(10_000),
  boxLengthCm: z.number().int().min(1).max(1000).optional(),
  boxWidthCm: z.number().int().min(1).max(1000).optional(),
  boxHeightCm: z.number().int().min(1).max(1000).optional(),
  boxWeightKg: z.number().min(0.001).max(10_000).optional(),
  totalWeightKg: z.number().min(0.001).max(1_000_000).optional(),
  totalVolumeM3: z.number().min(0.0001).max(10_000).optional(),
  note: z.string().trim().max(500).nullable().optional(),
  /** The factory barcode (0112, Q10 c): undefined = leave it, '' or null = clear it. */
  factoryBarcode: z.string().trim().max(64).nullable().optional(),
});

export type EditLotInput = z.infer<typeof editLotSchema>;

export class EditError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'edit_window_closed'
      | 'structural_locked'
      | 'boxes_not_editable'
      | 'boxes_crated'
      | 'receipt_not_confirmed'
      | 'receipt_has_compensation'
      | 'lot_changed'
      | 'shared_cost_orphaned'
      // The factory barcode and the office receipt's correction door (0112).
      | 'barcode_invalid'
      | 'barcode_is_ours'
      | 'received_locked'
      | 'receiver_invalid'
      | ReceivedDayRefusal,
  ) {
    super(code);
  }
}

/**
 * Edit rules (spec 4.4 / §16): the creator edits freely on the same
 * warehouse-local day; after that only manager-level users (those holding
 * `receipts.void`) may edit. Structural fields lock once any box has left
 * `in_stock` at origin (DECISIONS #5).
 */
export function canEditReceipt(
  actor: Actor,
  receipt: { createdBy: string; createdAt: Date },
  warehouseTimezone: string,
): boolean {
  if (actor.permissions.has('receipts.void')) return true;
  if (!actor.permissions.has('receipts.edit')) return false;
  if (receipt.createdBy !== actor.id) return false;
  const localDate = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: warehouseTimezone, dateStyle: 'short' }).format(d);
  return localDate(receipt.createdAt) === localDate(new Date());
}

/**
 * The lot form's barcode field, as the service stores it: undefined when the
 * form said nothing (leave it), null to clear, else the canonical key —
 * refused in words, as the receive door refuses it (`service.ts`).
 */
function barcodeEdit(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  const typed = raw?.trim() ?? '';
  if (!typed) return null;
  const key = factoryBarcodeKey(typed);
  if (!key) throw new EditError('barcode_invalid');
  if (isOwnCodeShape(key)) throw new EditError('barcode_is_ours');
  return key;
}

// --- The office receipt's correction door (0112, the owner's Q9 b) ---

export const receivedEditSchema = z.object({
  receiptId: z.string().uuid(),
  receivedDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  receivedBy: receivedBySchema,
});
export type ReceivedEditInput = z.infer<typeof receivedEditSchema>;

/**
 * May this person correct WHO received a prixod and ON WHICH DAY?
 *
 * The office count door (`mayCountMove` — plans.manage in scope) AND the day
 * the prixod was TYPED, in its warehouse's zone: a date typo is fixed the same
 * day, while the photos are in front of the typist; after that the day stands
 * like every other fact a report has already read, and a real mistake goes
 * through the void. The named receiver gets no edit right from being named
 * (decision 39): naming somebody is a statement ABOUT them, not a grant TO them.
 */
export function mayCorrectReceived(
  actor: Pick<Actor, 'permissions' | 'warehouseScoped' | 'warehouseIds'>,
  receipt: { status: string; warehouseId: string; createdAt: Date },
  warehouseTimezone: string,
  now: Date = new Date(),
): boolean {
  return (
    receipt.status === 'confirmed' &&
    mayCountMove(actor, receipt.warehouseId) &&
    dayIn(receipt.createdAt, warehouseTimezone) === dayIn(now, warehouseTimezone)
  );
}

/**
 * Correct the receiver and the real day of a prixod. The day is bounded the
 * way the receive door bounds it, measured from the ENTRY (`created_at`), so a
 * correction can never widen what was allowed; the entry day itself writes
 * `received_at = created_at` back — «not back-dated» stays derivable. One
 * audit row, and none at all when nothing changed.
 */
export async function setReceiptReceived(
  input: ReceivedEditInput,
  actor: Actor,
  ctx: AuditContext,
): Promise<{ changed: boolean }> {
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, input.receiptId) });
  if (!receipt) throw new EditError('not_found');
  if (receipt.status !== 'confirmed') throw new EditError('receipt_not_confirmed');
  const warehouse = (await db.query.warehouses.findFirst({
    where: eq(warehouses.id, receipt.warehouseId),
  }))!;
  if (!mayCorrectReceived(actor, receipt, warehouse.timezone)) throw new EditError('received_locked');
  const refusal = receivedDayRefusal(input.receivedDay, receipt.createdAt, warehouse.timezone);
  if (refusal) throw new EditError(refusal);
  // Pool read, before the transaction (#714).
  let receiver: { receivedByUserId: string | null; receivedByName: string | null };
  try {
    receiver = await checkReceiver(input.receivedBy, receipt.warehouseId, actor.id);
  } catch (err) {
    if (err instanceof ReceiptError) throw new EditError('receiver_invalid');
    throw err;
  }
  const at =
    receivedAtFor(input.receivedDay, receipt.createdAt, warehouse.timezone) ?? receipt.createdAt;

  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(receipts).where(eq(receipts.id, receipt.id)).for('update');
    if (!row || row.status !== 'confirmed') throw new EditError('receipt_not_confirmed');
    const before = {
      receivedAt: row.receivedAt.toISOString(),
      receivedByUserId: row.receivedByUserId,
      receivedByName: row.receivedByName,
    };
    const after = { receivedAt: at.toISOString(), ...receiver };
    const diff = diffFields(before, after);
    if (!diff) return { changed: false };
    await tx
      .update(receipts)
      .set({ receivedAt: at, ...receiver, updatedAt: new Date() })
      .where(eq(receipts.id, row.id));
    await writeAudit(tx, { ...ctx, warehouseId: row.warehouseId }, {
      entityType: 'receipt',
      entityId: row.id,
      action: 'update',
      ...diff,
    });
    return { changed: true };
  });
}

export interface LotEditResult {
  /** Label reconciliation (spec 4.4): what the operator must do physically. */
  labelsToPrint: number;
  labelsToDestroy: string[];
}

export async function editLot(
  input: EditLotInput,
  actor: Actor,
  ctx: AuditContext,
): Promise<LotEditResult> {
  const lot = await db.query.receiptLots.findFirst({ where: eq(receiptLots.id, input.lotId) });
  if (!lot) throw new EditError('not_found');
  const receipt = (await db.query.receipts.findFirst({ where: eq(receipts.id, lot.receiptId) }))!;
  /**
   * A VOIDED receipt is not editable, and the structural lock below cannot
   * say so on its own.
   *
   * That guard reads «no ACTIVE box has left in_stock», and on a voided
   * receipt every box is `void`, so the active list is EMPTY and
   * `[].some(...)` is false — the lock passes by being asked about nothing.
   * The grow branch then inserted brand-new `in_stock` boxes with fresh short
   * codes and printed labels for them: live, plannable, loadable cargo hanging
   * off a prixod that officially never happened. Reachable with no race at
   * all — a manager voids the receipt while a colleague has the lot form open,
   * and the colleague presses Save.
   */
  if (receipt.status !== 'confirmed') throw new EditError('receipt_not_confirmed');
  const warehouse = (await db.query.warehouses.findFirst({
    where: eq(warehouses.id, receipt.warehouseId),
  }))!;

  if (!canEditReceipt(actor, receipt, warehouse.timezone)) {
    throw new EditError('edit_window_closed');
  }

  const lotBoxes = await db
    .select()
    .from(boxes)
    .where(eq(boxes.lotId, lot.id))
    .orderBy(asc(boxes.seqInLot));
  const activeBoxes = lotBoxes.filter((b) => b.status !== 'void');
  const countChange = input.boxCount !== activeBoxes.length;
  const measureChange =
    (lot.dimsMode === 'uniform' &&
      (input.boxLengthCm !== lot.boxLengthCm ||
        input.boxWidthCm !== lot.boxWidthCm ||
        input.boxHeightCm !== lot.boxHeightCm ||
        Number(input.boxWeightKg) !== Number(lot.boxWeightKg))) ||
    (lot.dimsMode === 'mixed' &&
      (Number(input.totalWeightKg) !== Number(lot.totalWeightKg) ||
        Number(input.totalVolumeM3) !== Number(lot.totalVolumeM3)));
  const boxesLeft = activeBoxes.some((b) => b.status !== 'in_stock');
  /**
   * The structural lock, split in two (owner, 2026-08-25: «skladchi … kubi
   * bn kgmini hato kirgazgan shunday payit tuzatb bolmayabti», his 5b).
   *
   * The box COUNT stays locked for everybody once any box has left the
   * shelf: a carton count is what the truck, the labels and the scans agree
   * on, and changing it mid-journey would mint or void boxes that are
   * physically somewhere.
   *
   * The MEASURES (kg, m³, dims) unlock for `receipts.void` holders — the
   * same manager level that can void the receipt outright. A wrong weight
   * frozen for ever feeds the tannarx allocation, the truck's capacity
   * numbers and the client's bill with a number everybody knows is false,
   * which is worse than letting a manager correct it on the record: the
   * audit diff below names the change, every cost shared over the lot —
   * the truck's freight included (`recomputeForLot`) — re-allocates
   * immediately, and the receipt's author is told.
   */
  if (countChange && boxesLeft) throw new EditError('structural_locked');
  if (measureChange && boxesLeft && !actor.permissions.has('receipts.void')) {
    throw new EditError('structural_locked');
  }

  // The factory barcode (0112, Q10 c): NOT structural — it identifies the pile
  // and moves nothing, so it is correctable after the cartons have left.
  const barcode = barcodeEdit(input.factoryBarcode);

  const chargeableFactor = await getSetting('chargeable_weight_factor');
  const totals = computeLotTotals(
    lot.dimsMode === 'uniform'
      ? {
          dimsMode: 'uniform',
          boxCount: input.boxCount,
          boxLengthCm: input.boxLengthCm!,
          boxWidthCm: input.boxWidthCm!,
          boxHeightCm: input.boxHeightCm!,
          boxWeightKg: input.boxWeightKg!,
        }
      : {
          dimsMode: 'mixed',
          boxCount: input.boxCount,
          totalWeightKg: input.totalWeightKg!,
          totalVolumeM3: input.totalVolumeM3!,
        },
    chargeableFactor,
  );

  return db.transaction(async (tx) => {
    // Every decision above was read on the pool. The lot row is taken first
    // (the count doors' order: lot, then cartons) and the lot re-read under
    // it: an office count that grew or shrank the prixod while this form was
    // being decided would otherwise be written over with the form's stale
    // count and totals — five live cartons under a prixod saying three
    // (review of the fixes, lock-rv2-1).
    const [locked] = await tx.select().from(receiptLots).where(eq(receiptLots.id, lot.id)).for('update');
    const [live] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(boxes)
      .where(and(eq(boxes.lotId, lot.id), ne(boxes.status, 'void')));
    if (
      !locked ||
      locked.boxCount !== lot.boxCount ||
      Number(locked.totalWeightKg) !== Number(lot.totalWeightKg) ||
      Number(locked.totalVolumeM3) !== Number(lot.totalVolumeM3) ||
      Number(live!.n) !== activeBoxes.length
    ) {
      throw new EditError('lot_changed');
    }
    const before = {
      productNameZh: lot.productNameZh,
      productNameRu: lot.productNameRu,
      boxCount: activeBoxes.length,
      boxLengthCm: lot.boxLengthCm,
      boxWidthCm: lot.boxWidthCm,
      boxHeightCm: lot.boxHeightCm,
      boxWeightKg: lot.boxWeightKg ? Number(lot.boxWeightKg) : null,
      totalWeightKg: Number(lot.totalWeightKg),
      totalVolumeM3: Number(lot.totalVolumeM3),
      note: lot.note,
      ...(barcode !== undefined ? { factoryBarcode: lot.factoryBarcode } : {}),
    };
    const after = {
      productNameZh: input.productNameZh,
      productNameRu: input.productNameRu || null,
      boxCount: input.boxCount,
      boxLengthCm: input.boxLengthCm ?? null,
      boxWidthCm: input.boxWidthCm ?? null,
      boxHeightCm: input.boxHeightCm ?? null,
      boxWeightKg: input.boxWeightKg ?? null,
      totalWeightKg: totals.totalWeightKg,
      totalVolumeM3: totals.totalVolumeM3,
      note: input.note ?? null,
      ...(barcode !== undefined ? { factoryBarcode: barcode } : {}),
    };

    await tx
      .update(receiptLots)
      .set({
        productNameZh: input.productNameZh,
        productNameRu: input.productNameRu || null,
        boxCount: input.boxCount,
        boxLengthCm: input.boxLengthCm ?? null,
        boxWidthCm: input.boxWidthCm ?? null,
        boxHeightCm: input.boxHeightCm ?? null,
        boxWeightKg: input.boxWeightKg?.toString() ?? null,
        totalWeightKg: totals.totalWeightKg.toString(),
        totalVolumeM3: totals.totalVolumeM3.toString(),
        note: input.note ?? null,
        ...(barcode !== undefined ? { factoryBarcode: barcode } : {}),
      })
      .where(eq(receiptLots.id, lot.id));

    const result: LotEditResult = { labelsToPrint: 0, labelsToDestroy: [] };

    // Label reconciliation on count change (spec 4.4, edge case 1).
    const delta = input.boxCount - activeBoxes.length;
    if (delta > 0) {
      // Warehouse before counter — confirmReceipt's order (lock-rv2-5).
      await tx.execute(sql`SELECT 1 FROM warehouses WHERE id = ${warehouse.id}::uuid FOR KEY SHARE`);
      const codes = await nextBoxCodes(tx, warehouse, delta);
      const maxSeq = Math.max(0, ...lotBoxes.map((b) => b.seqInLot));
      const inserted = await tx
        .insert(boxes)
        .values(
          codes.map((shortCode, idx) => ({
            lotId: lot.id,
            shortCode,
            seqInLot: maxSeq + idx + 1,
            status: 'in_stock',
            currentWarehouseId: warehouse.id,
          })),
        )
        .returning({ id: boxes.id });
      await tx.insert(boxMovements).values(
        inserted.map((b) => ({
          boxId: b.id,
          toWarehouseId: warehouse.id,
          toStatus: 'in_stock',
          cause: 'lot_edit_add',
          refType: 'receipt',
          refId: receipt.id,
          actorId: ctx.actorId,
        })),
      );
      // A QR-siz lot's new cartons are QR-siz too (no label stamp, 0112): the
      // office counts them, nobody prints them here.
      result.labelsToPrint = lot.qrSkippedAt ? 0 : delta;
    } else if (delta < 0) {
      // The third door that writes `void`, now under the other two's rules
      // (review of wb2, U0/U8): every cost shared over the lot locked BEFORE
      // the boxes (U20's race — a box-card void running at the same moment
      // must wait instead of reading this shrink's carton as live), the
      // boxes re-read under the lock (the pre-read above is a plan, not a
      // fact), and the money asked before a carton goes: a crate fee that
      // these surplus cartons ARE the whole base of would sit on no box. A
      // crated surplus carton still leaves its crate (round 31, #406) — only
      // when that would strand the crate's money is the shrink refused.
      const costs = await lockCostsTouchingLots([lot.id], tx);
      const current = await tx
        .select()
        .from(boxes)
        .where(and(eq(boxes.lotId, lot.id), ne(boxes.status, 'void')))
        .orderBy(asc(boxes.seqInLot))
        .for('update');
      if (current.length !== activeBoxes.length) throw new EditError('lot_changed');
      const toVoid = current.slice(delta); // highest seq_in_lot last
      if (toVoid.some((box) => box.status !== 'in_stock')) throw new EditError('boxes_not_editable');
      const orphan = await costOrphanedByVoid(
        costs,
        toVoid.map((box) => box.id),
        Number(chargeableFactor),
        tx,
      );
      if (orphan) throw new EditError('shared_cost_orphaned');
      // Asked BEFORE the void clears crate_id: only a sticker that exists can
      // be torn off, and a QR-siz carton has none of ours (0112).
      const stickerless = new Set(
        (
          await tx
            .select({ id: boxes.id })
            .from(boxes)
            .where(and(inArray(boxes.id, toVoid.map((box) => box.id)), qrlessBoxSql()))
        ).map((row) => row.id),
      );
      for (const box of toVoid) {
        // A voided box leaves its crate too: a void member made the crate
        // permanently undissolvable and unscannable (both walk the members
        // and refuse anything not in_stock).
        await tx
          .update(boxes)
          .set({ status: 'void', statusReason: 'lot edit: box count reduced', crateId: null })
          .where(eq(boxes.id, box.id));
        await tx.insert(boxMovements).values({
          boxId: box.id,
          fromStatus: box.status,
          toStatus: 'void',
          cause: 'lot_edit_remove',
          refType: 'receipt',
          refId: receipt.id,
          actorId: ctx.actorId,
        });
      }
      result.labelsToDestroy = toVoid.filter((b) => !stickerless.has(b.id)).map((b) => b.shortCode);
      // Unlike the other write-off doors this one never asks the funnel
      // (`advanceDealsAfterWriteOff`): a count change is refused once any
      // box has left the shelf, and a lot keeps at least one box — so the
      // lot still has a carton on the shelf after the shrink, and a deal
      // carrying it cannot have become fully handed by it.
    }

    const diff = diffFields(before, after);
    if (diff) {
      await writeAudit(tx, { ...ctx, warehouseId: warehouse.id }, {
        entityType: 'receipt',
        entityId: receipt.id,
        action: 'update',
        ...diff,
      });
    }
    return result;
  }).then(async (result) => {
    // The receipt's costs were shared over boxes that just changed: a shrink
    // voids the miscounted surplus, and its shares must move onto the real
    // boxes NOW, not at the next FX sweep — the batch pricing screen reads
    // them through membership a shelf-voided box can never have, so until a
    // resweep the client's landed cost quietly understated by exactly the
    // phantom boxes' share. A grow redistributes the same way — and so does a
    // measure correction, because weight- and volume-based allocations read
    // the very numbers that just changed. Outside the transaction on purpose:
    // the engine re-reads the boxes it allocates over, and money must not be
    // able to roll back a warehouse's count fix.
    const totalsChanged =
      totals.totalWeightKg !== Number(lot.totalWeightKg) ||
      totals.totalVolumeM3 !== Number(lot.totalVolumeM3);
    if (result.labelsToPrint > 0 || result.labelsToDestroy.length > 0 || totalsChanged) {
      // Every cost shared over this lot — the truck's freight and a crate's
      // fee too, not only the receipt's own (audit A22).
      //
      // A failure here is NOT the manager's: the correction has committed,
      // so rethrowing it painted a saved fix as an error page and skipped the
      // author's notice below (U41, measured on overlapping corrections). It
      // is logged and handed to the job queue as a durable retry of the same
      // re-split, which pg-boss repeats until it lands.
      try {
        const { recomputeForLot } = await import('../costing/service');
        await recomputeForLot(lot.id);
      } catch (error) {
        console.error('[lot-edit] recompute failed, queued for retry', lot.id, error);
        try {
          const { enqueue, JOB_RECOMPUTE_COSTS } = await import('../../platform/jobs/boss');
          await enqueue(JOB_RECOMPUTE_COSTS, { lotId: lot.id });
        } catch (queueError) {
          // The nightly orphan sweep is the last net under this one.
          console.error('[lot-edit] recompute retry could not be queued', lot.id, queueError);
        }
      }
    }
    // A correction made over the author's head is told to the author — the
    // arrival-diff rule: the person whose record changed hears it first,
    // never the client.
    if (measureChange && boxesLeft && receipt.createdBy && receipt.createdBy !== actor.id) {
      const { notifyStaffTelegram } = await import('../../platform/notifications/staff');
      await notifyStaffTelegram({
        userIds: [receipt.createdBy],
        type: 'ReceiptMeasureCorrected',
        exceptUserId: actor.id,
        text:
          `✏️ Prixod ${receipt.number ?? ''} (${lot.letter ?? ''} — ${lot.productNameZh}) o'lchovi tuzatildi:\n` +
          `${Number(lot.totalWeightKg)} kg → ${totals.totalWeightKg} kg · ` +
          `${Number(lot.totalVolumeM3)} m³ → ${totals.totalVolumeM3} m³\n` +
          `Tuzatdi: ${actor.fullName}`,
      }).catch(() => {});
    }
    return result;
  });
}

/** Reverted codes an audit row names at most (the count is always whole). */
const REVERTED_CODES_CAP = 500;

/**
 * Where the QR-siz switch of a lot is decided — ONE answer for the service and
 * the receipt card's toggle (#513).
 *
 * While every loose carton that is still ours to move stands on the shelf of
 * the prixod's own warehouse, the switch is the lot form's: the same-day
 * creator, and past the shelf a manager (`receipts.void`). Once one of them is
 * planned onto a truck, riding one, or standing in another warehouse, marking
 * or unmarking the lot changes how THAT truck is loaded and how THAT warehouse
 * scans it — a logistics decision (plan decision 28: only the count door may
 * drop an uncounted QR-siz lot at «yuklash tugadi»), so it needs the count
 * door at every place the cartons are: each warehouse they stand in and both
 * ends of every truck they are on. `receipts.void` at the prixod's warehouse
 * let a manager unmark a planned lot and short-load it past that gate, or
 * re-mark a lot in transit so the destination's phones refused cartons whose
 * stickers were on (review access-1). Crated cartons are not the switch's
 * (their crate's label stands in for them), issued and lost ones have left.
 */
export interface QrSwitchPlaces {
  /** Every loose, still-ours carton is `in_stock` at the prixod's warehouse. */
  onReceiptShelf: boolean;
  /** Any live carton (crated included) is past the shelf — the old manager rule. */
  anyNotInStock: boolean;
  /** Warehouses the count door is needed at when not `onReceiptShelf`. */
  places: string[];
}

export async function qrSwitchPlaces(
  exec: Db | Tx,
  lotId: string,
  receiptWarehouseId: string,
): Promise<QrSwitchPlaces> {
  const live = await exec
    .select({
      status: boxes.status,
      crateId: boxes.crateId,
      warehouseId: boxes.currentWarehouseId,
      batchId: boxes.currentBatchId,
    })
    .from(boxes)
    .where(and(eq(boxes.lotId, lotId), ne(boxes.status, 'void')));
  // Crated cartons included: the marker is the LOT's, and a pallet's members
  // take it the moment the pallet is broken down. Judging loose cartons alone,
  // a lot riding entirely inside a pallet looked «on the shelf» (an empty
  // list agrees with anything) and the origin's manager could re-mark a lot
  // on the road (review of the fixes, cargo-r2 — access-1 through a pallet).
  const held = live.filter((box) => box.status !== 'issued' && box.status !== 'lost');
  const onReceiptShelf = held.every(
    (box) => box.status === 'in_stock' && box.warehouseId === receiptWarehouseId && box.batchId === null,
  );
  const places = new Set<string>();
  for (const box of held) if (box.warehouseId) places.add(box.warehouseId);
  const batchIds = [...new Set(held.map((box) => box.batchId).filter((id): id is string => id !== null))];
  if (batchIds.length > 0) {
    const ends = await exec
      .select({ origin: batches.originWarehouseId, dest: batches.destWarehouseId })
      .from(batches)
      .where(inArray(batches.id, batchIds));
    for (const end of ends) {
      places.add(end.origin);
      places.add(end.dest);
    }
  }
  return {
    onReceiptShelf,
    anyNotInStock: live.some((box) => box.status !== 'in_stock'),
    places: [...places],
  };
}

/** The switch's gate over `qrSwitchPlaces` (the edit window is asked before). */
export function mayFlipQrSkip(actor: Actor, at: QrSwitchPlaces): boolean {
  if (at.onReceiptShelf) return !at.anyNotInStock || actor.permissions.has('receipts.void');
  return at.places.length > 0 && at.places.every((warehouseId) => mayCountMove(actor, warehouseId));
}

/**
 * The QR-siz switch's door as the ACTION asks it — `receipts.edit` at the
 * prixod's own warehouse — so the receipt card draws the switch exactly where
 * pressing it is allowed (review of the fixes, cargo-r5). A write door, not
 * the read door (`mayReadReceipt`): a destination may read a prixod it cannot
 * edit.
 */
export function mayEditReceiptAt(
  actor: Pick<Actor, 'permissions' | 'warehouseScoped' | 'warehouseIds'>,
  warehouseId: string,
): boolean {
  return actor.permissions.has('receipts.edit') && inScope(actor, warehouseId);
}

/**
 * «QR yopishtirilmadi» changed after the receipt (0112, decision 32) — a
 * two-way switch on the receipt card, never a field in the lot form.
 *
 * The gate is `mayFlipQrSkip`: the lot form's while the cartons are on the
 * prixod's own shelf, the count door wherever they have gone.
 *
 * MARK sets the marker to now(): on a lot whose stickers were printed and fell
 * off (sacks, rolls), every live uncrated carton labelled before it becomes
 * QR-siz again, and the audit names them. It is a no-op — no write, no audit
 * row — when every live uncrated carton is already QR-siz. UNMARK clears it:
 * the lot's cartons are expected to be scanned from now on.
 */
export async function setLotQrSkipped(
  input: { lotId: string; skipped: boolean },
  actor: Actor,
  ctx: AuditContext,
): Promise<{ changed: boolean; reverted: number }> {
  const lot = await db.query.receiptLots.findFirst({ where: eq(receiptLots.id, input.lotId) });
  if (!lot) throw new EditError('not_found');
  const receipt = (await db.query.receipts.findFirst({ where: eq(receipts.id, lot.receiptId) }))!;
  if (receipt.status !== 'confirmed') throw new EditError('receipt_not_confirmed');
  const warehouse = (await db.query.warehouses.findFirst({
    where: eq(warehouses.id, receipt.warehouseId),
  }))!;
  if (!canEditReceipt(actor, receipt, warehouse.timezone)) throw new EditError('edit_window_closed');

  return db.transaction(async (tx) => {
    // The lot row first: two presses of the switch take turns.
    const [current] = await tx
      .select({ qrSkippedAt: receiptLots.qrSkippedAt })
      .from(receiptLots)
      .where(eq(receiptLots.id, lot.id))
      .for('update');
    await tx
      .select({ id: boxes.id })
      .from(boxes)
      .where(and(eq(boxes.lotId, lot.id), ne(boxes.status, 'void')))
      .orderBy(asc(boxes.id))
      .for('update');
    // Judged on the locked rows, inside the transaction that writes.
    if (!mayFlipQrSkip(actor, await qrSwitchPlaces(tx, lot.id, receipt.warehouseId))) {
      throw new EditError('structural_locked');
    }
    const markedBefore = current?.qrSkippedAt ?? null;

    if (!input.skipped) {
      if (!markedBefore) return { changed: false, reverted: 0 };
      await tx.update(receiptLots).set({ qrSkippedAt: null }).where(eq(receiptLots.id, lot.id));
      await writeAudit(tx, { ...ctx, warehouseId: warehouse.id }, {
        entityType: 'receipt',
        entityId: receipt.id,
        action: 'update',
        before: { qrSkipped: lot.letter },
        after: { qrSkipped: null },
      });
      return { changed: true, reverted: 0 };
    }

    // The cartons that are NOT QR-siz now and will be once the lot is marked:
    // live, uncrated (a crate's own label stands in for its members).
    const reverting = await tx
      .select({ shortCode: boxes.shortCode, labelPrintedAt: boxes.labelPrintedAt })
      .from(boxes)
      .where(
        and(
          eq(boxes.lotId, lot.id),
          ne(boxes.status, 'void'),
          isNull(boxes.crateId),
          sql`NOT ${qrlessBoxSql()}`,
        ),
      )
      .orderBy(asc(boxes.seqInLot));
    if (markedBefore && reverting.length === 0) return { changed: false, reverted: 0 };
    // …and of those, the ones that carried a printed sticker: what the switch
    // takes back is only ever a label that existed.
    const reverted = reverting.filter((row) => row.labelPrintedAt !== null);
    await tx
      .update(receiptLots)
      .set({ qrSkippedAt: sql`now()` })
      .where(eq(receiptLots.id, lot.id));
    await writeAudit(tx, { ...ctx, warehouseId: warehouse.id }, {
      entityType: 'receipt',
      entityId: receipt.id,
      action: 'update',
      before: { qrSkipped: markedBefore ? lot.letter : null },
      after: {
        qrSkipped: lot.letter,
        // A mark takes back stickers that were printed (a re-mark always
        // does): which ones is the only way to tell afterwards what it undid.
        ...(reverted.length
          ? {
              qrReverted: reverted.length,
              qrRevertedCodes: reverted.slice(0, REVERTED_CODES_CAP).map((row) => row.shortCode),
            }
          : {}),
      },
    });
    return { changed: true, reverted: reverted.length };
  });
}

/**
 * Assign (or change) the client of a receipt — resolves unclaimed cargo
 * (spec 6.7 assign path) and fixes wrong-client mistakes. Fully audited;
 * the new client's sales manager is notified.
 */
export async function assignReceiptClient(
  receiptId: string,
  clientId: string,
  ctx: AuditContext,
): Promise<void> {
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
  if (!receipt) throw new EditError('not_found');
  // Same rule as the lot form: a voided intake takes no more corrections.
  if (receipt.status !== 'confirmed') throw new EditError('receipt_not_confirmed');
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) throw new EditError('not_found');
  const warehouse = (await db.query.warehouses.findFirst({
    where: eq(warehouses.id, receipt.warehouseId),
  }))!;

  const beforeClient = receipt.clientId
    ? await db.query.clients.findFirst({ where: eq(clients.id, receipt.clientId) })
    : null;

  // CHANGING the client of crated cargo would silently break the one-client
  // rule the crate was packed under — the crate row would go on naming the
  // old client while its boxes answer to the new one. Dissolve first, then
  // reassign. (Unclaimed cargo cannot be crated, so first assignment passes.)
  if (receipt.clientId && receipt.clientId !== clientId) {
    const [crated] = await db
      .select({ id: boxes.id })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .innerJoin(crates, eq(boxes.crateId, crates.id))
      .where(and(eq(receiptLots.receiptId, receiptId), eq(crates.status, 'active')))
      .limit(1);
    if (crated) throw new EditError('boxes_crated');
    // A compensation (0105) names this prixod and is money we owe THIS
    // client: changing the client is money, corrected by void + re-entry on
    // the right client by the accountant — never carried along by a click.
    // Asked before the direct-cost decision so the refusal comes first.
    if (await receiptHasCompensation(db, receiptId)) throw new EditError('receipt_has_compensation');
  }

  // A cost typed «only for this client» (direct_to_client) after a client
  // correction (U39). The share UPDATE below re-stamps the SNAPSHOT, but the
  // entry still names the OLD client and the engine splits it over that
  // client's boxes only — so the next recompute (the depart job, a lot fix,
  // the nightly pickup sweep) either deleted every share and wrote none (the
  // dollars stayed in the P&L and left every tannarx) or moved the whole fee
  // back onto the old client's other cargo: two writers of one fact, and
  // whichever ran last decided. Decided here, ONCE, on the POOL before the
  // transaction (scopeBoxIds and the recompute read on it, #714):
  //  - the prixod's OWN direct cost moves (the receipt card only ever offers
  //    the receipt's own client, so on anyone else it could never split);
  //  - a truck / crate / factory-trip direct cost moves when the old client
  //    has NO other cargo left in its scope — otherwise the money lands on
  //    nobody;
  //  - when the old client still has cargo there, the cost STAYS theirs —
  //    whoever typed it wrote «for GS100» (owner's answer A, 2026-09-25) —
  //    and is re-split onto that remaining cargo straight after the commit,
  //    so the corrected prixod never carries a share of a cost addressed to
  //    somebody else.
  const direct =
    receipt.clientId && receipt.clientId !== clientId
      ? await directCostsAfterClientChange(receiptId, receipt.clientId)
      : { move: [], keep: [] };
  const directToMove = direct.move;

  await db.transaction(async (tx) => {
    // The marking is KEPT, not nulled (round 98, owner: «gs500maniken-al
    // shaklida qolib, client faqat gs500 ni yuki deb belgilay olamizmi»). The
    // sticker on the box physically says `GS500MANIKEN-AL`; nulling the
    // marking made the system print `GS500-AL` instead, so the label and the
    // box disagreed. Now the printed code stays the marking and the client
    // owns the cargo underneath it. Safe because «unclaimed» is decided by
    // `clientId IS NULL` everywhere, never by the marking's presence — so a
    // claimed receipt that keeps its marking is still counted as claimed.
    //
    // The seller stamp moves WITH the client, in the same statement (0117):
    // a claim stamps whoever sells to the claimant now, and an A→B
    // correction restamps to B's seller — the cargo was never A's. A month
    // already paid to A is absorbed by the per-seller netting, never paid
    // twice (wms/staff/kpi-service.ts).
    await tx
      .update(receipts)
      .set({ clientId, salesManagerId: stampFor(sql`${clientId}::uuid`) })
      .where(eq(receipts.id, receiptId));
    // Re-asked under the row lock the UPDATE just took: a compensation
    // written between the pre-check and here waited on the prixod's lock
    // (`addCompensation` takes it FOR UPDATE first) or is seen now.
    if (receipt.clientId && receipt.clientId !== clientId && (await receiptHasCompensation(tx, receiptId))) {
      throw new EditError('receipt_has_compensation');
    }

    /**
     * The money follows the cargo.
     *
     * `cost_allocations.client_id` is a denormalised SNAPSHOT of the
     * receipt's client, taken when the cost was allocated — and unclaimed
     * cargo is exactly the case where costs (customs, freight) are entered
     * BEFORE anybody knows whose it is, so those rows carry NULL. Nothing
     * re-derived them, so every report keyed on that column went on saying
     * the money belongs to nobody: the client showed revenue with no cost and
     * read as pure profit, `landedCostByClient` — the owner's most-used
     * report — inner-joins `clients` and dropped the row entirely, and the
     * pricing screen's total stopped agreeing with the breakdown it opens,
     * because one groups by the allocation and the other by the receipt.
     * A correction from GS500 to GS501 left the cost on GS500 for ever.
     */
    await tx.execute(sql`
      UPDATE cost_allocations SET client_id = ${clientId}
      WHERE box_id IN (
        SELECT b.id FROM boxes b
        JOIN receipt_lots rl ON rl.id = b.lot_id
        WHERE rl.receipt_id = ${receiptId}
      )
    `);

    // …and the direct costs decided above, re-checked in the WHERE so a cost
    // voided or re-pointed meanwhile is left alone. Audited on the cost row:
    // whose tannarx a fee belongs to is a money fact, not a cargo one.
    if (directToMove.length && receipt.clientId) {
      const moved = await tx
        .update(costEntries)
        .set({ clientId, updatedAt: new Date() })
        .where(
          and(
            inArray(costEntries.id, directToMove),
            eq(costEntries.clientId, receipt.clientId),
            eq(costEntries.allocationBasis, 'direct_to_client'),
            isNull(costEntries.voidedAt),
          ),
        )
        .returning({ id: costEntries.id });
      for (const row of moved) {
        await writeAudit(tx, { ...ctx, warehouseId: warehouse.id }, {
          entityType: 'cost_entry',
          entityId: row.id,
          action: 'update',
          before: { clientId: receipt.clientId },
          after: { clientId, from: 'receipt_client_change', receiptId },
        });
      }
    }

    await writeAudit(tx, { ...ctx, warehouseId: warehouse.id }, {
      entityType: 'receipt',
      entityId: receiptId,
      action: 'update',
      before: { client: beforeClient?.clientCode ?? receipt.unclaimedMarking ?? null },
      after: { client: client.clientCode },
    });

    const lots = await tx
      .select()
      .from(receiptLots)
      .where(eq(receiptLots.receiptId, receiptId))
      .orderBy(asc(receiptLots.seq));
    await emitEvent(tx, {
      type: 'ReceiptConfirmed',
      payload: {
        receiptId,
        number: receipt.number,
        warehouseId: warehouse.id,
        warehouseCode: warehouse.code,
        clientId,
        assignedFromUnclaimed: !receipt.clientId,
        lots: lots.map((lot) => ({
          lotId: lot.id,
          letter: lot.letter,
          productNameZh: lot.productNameZh,
          productNameRu: lot.productNameRu,
          boxCount: lot.boxCount,
          totalWeightKg: Number(lot.totalWeightKg),
          totalVolumeM3: Number(lot.totalVolumeM3),
        })),
      },
      entityType: 'receipt',
      entityId: receiptId,
      actorId: ctx.actorId,
    });
    // The new owner's «qabul qilindi», once (round C) — read at send time, so
    // cargo that left China weeks ago is announced as added to the cabinet
    // where it really is, never as just received.
    await claimReceivedNotice(tx, clientId, receiptId);
  });

  // EVERY cost shared over this prixod re-splits by the ENGINE after the
  // commit, not only the direct ones: the share UPDATE above is a first draft,
  // and it is not the only writer. A recompute of the truck's freight that
  // overlapped this correction (the depart job, a lot fix aboard the same
  // truck, a void's re-split, the nightly sweep) read the OLD client under its
  // entry lock, waited on the draft's row locks, and inserted its shares
  // stamped with the old client after we committed — rows the draft's
  // statement never saw, on no void box and never empty, so no sweep would
  // ever look at them again: profit-by-client and the client's landed cost
  // kept the corrected prixod's freight on the wrong customer (U39's review).
  // Re-split here, each entry under its lock, this is the LAST writer and it
  // reads the committed client. A moved direct cost lands on the new client's
  // cargo, a kept one on the old client's remaining cargo. Never able to roll
  // the correction back (#714); a failure is logged and handed to the job
  // queue as the same re-split, which pg-boss repeats until it lands — the
  // nightly sweep cannot see a wrong stamp.
  const lotIds = (
    await db
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .where(eq(receiptLots.receiptId, receiptId))
  ).map((lot) => lot.id);
  if (lotIds.length) {
    try {
      const { recomputeForLots } = await import('../costing/service');
      await recomputeForLots(lotIds);
    } catch (error) {
      console.error('[receipt-client] recompute failed, queued for retry', receiptId, error);
      try {
        const { enqueue, JOB_RECOMPUTE_COSTS } = await import('../../platform/jobs/boss');
        for (const lotId of lotIds) await enqueue(JOB_RECOMPUTE_COSTS, { lotId });
      } catch (queueError) {
        console.error(
          '[receipt-client] recompute retry could not be queued',
          receiptId,
          queueError,
        );
      }
    }
  }
}

/**
 * The live direct_to_client costs of `oldClientId` this prixod is part of,
 * split into those that follow it to its new client (`move`) and those that
 * stay on the old client's remaining cargo (`keep`) — U39, see
 * `assignReceiptClient`. Membership is the lot-level one
 * (`costEntriesTouchingLots`, so an UNCONVERTED cost with no share yet is
 * found too), and the base each cost would split over is the engine's own
 * (`scopeBoxIds`).
 */
async function directCostsAfterClientChange(
  receiptId: string,
  oldClientId: string,
): Promise<{ move: string[]; keep: string[] }> {
  const lotIds = (
    await db.select({ id: receiptLots.id }).from(receiptLots).where(eq(receiptLots.receiptId, receiptId))
  ).map((l) => l.id);
  const { costEntriesTouchingLots } = await import('../costing/void-guard');
  const touching = await costEntriesTouchingLots(lotIds);
  if (touching.length === 0) return { move: [], keep: [] };
  const direct = await db
    .select()
    .from(costEntries)
    .where(
      and(
        inArray(costEntries.id, touching),
        eq(costEntries.allocationBasis, 'direct_to_client'),
        eq(costEntries.clientId, oldClientId),
        isNull(costEntries.voidedAt),
      ),
    );
  if (direct.length === 0) return { move: [], keep: [] };
  const own = new Set(
    (
      await db
        .select({ id: boxes.id })
        .from(boxes)
        .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
        .where(and(eq(receiptLots.receiptId, receiptId), ne(boxes.status, 'void')))
    ).map((b) => b.id),
  );
  const { scopeBoxIds } = await import('../costing/service');
  const move: string[] = [];
  const keep: string[] = [];
  for (const entry of direct) {
    if (entry.scope === 'receipt') {
      if (entry.receiptId === receiptId) move.push(entry.id);
      continue;
    }
    const base = await scopeBoxIds(entry);
    // Only a cost this prixod is actually part of.
    if (!base.some((id) => own.has(id))) continue;
    const [elsewhere] = await db
      .select({ id: boxes.id })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .where(
        and(
          inArray(boxes.id, base),
          eq(receipts.clientId, oldClientId),
          ne(receiptLots.receiptId, receiptId),
        ),
      )
      .limit(1);
    if (elsewhere) keep.push(entry.id);
    else move.push(entry.id);
  }
  return { move, keep };
}

/** Most recent lots first for the stock table (helper reused by pages). */
export async function latestLotBoxStats(lotId: string) {
  return db
    .select()
    .from(boxes)
    .where(and(eq(boxes.lotId, lotId), eq(boxes.status, 'in_stock')))
    .orderBy(desc(boxes.seqInLot));
}
