import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
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
import { nextBoxCodes } from '../codes';
import { receiptHasCompensation } from '../finance/compensation-follow';
import { computeLotTotals } from './math';

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
      | 'receipt_has_compensation',
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
      })
      .where(eq(receiptLots.id, lot.id));

    const result: LotEditResult = { labelsToPrint: 0, labelsToDestroy: [] };

    // Label reconciliation on count change (spec 4.4, edge case 1).
    const delta = input.boxCount - activeBoxes.length;
    if (delta > 0) {
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
      result.labelsToPrint = delta;
    } else if (delta < 0) {
      const toVoid = activeBoxes.slice(delta); // highest seq_in_lot last
      for (const box of toVoid) {
        if (box.status !== 'in_stock') throw new EditError('boxes_not_editable');
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
      result.labelsToDestroy = toVoid.map((b) => b.shortCode);
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
    await tx.update(receipts).set({ clientId }).where(eq(receipts.id, receiptId));
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
