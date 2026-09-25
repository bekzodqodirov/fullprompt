import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import { boxes, boxMovements, receiptLots, receipts, warehouses } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';
import { getSetting } from '../../platform/settings/service';
import { landedStatusFor } from '../warehouses/landed';
import { costOrphanedByVoid, lockCostsTouchingLots, type LockedCosts } from '../costing/void-guard';
import { roadLossTruck } from './road-loss';

export class BoxStatusError extends Error {
  constructor(
    public readonly code: string,
    /** What the sentence names — the crate or the truck whose cost would be left on no cargo. */
    public readonly detail?: string,
  ) {
    super(code);
  }
}

export const setBoxStatusSchema = z.object({
  boxId: z.string().uuid(),
  /** `in_stock` = "found" — a lost box recovered by a manager (owner's answer Q3). */
  to: z.enum(['lost', 'void', 'in_stock']),
  reason: z.string().trim().min(3).max(500),
  /**
   * Where a box that stands in NO warehouse was found — a carton written off
   * as lost on the road (`resolveMissing`'s `lost_in_transit`) has none, and
   * without this the one door back refused it for ever. Read only for a
   * restore of such a box; a box that has a warehouse comes back where it was
   * written off.
   */
  foundAtWarehouseId: z.string().uuid().optional(),
});
export type SetBoxStatusInput = z.infer<typeof setBoxStatusSchema>;

/**
 * Manager-only box status flows (spec 5.5, edge case 11): in_stock → lost/void
 * with a mandatory reason; lost → in_stock when found. Boxes in an active
 * crate must be un-crated (dissolve) first so crate contents stay truthful.
 *
 * The RESTORE half is the undo for every write-off in the system — the
 * stocktake's tick-list, the receipt card's fold and the bin scan all reach
 * `lost` and this is the one door back. The corrections round's review found
 * it shipping three ways to lie:
 *
 *  - it landed a blanket `in_stock`, so a Tashkent carton restored at a
 *    warehouse that issues to clients never reached any «tayyor» list and the
 *    customer's cabinet read «O'zbekistonda» for ever;
 *  - it asked nothing about the RECEIPT, so a box lost before its receipt was
 *    voided came back as live, plannable, sellable stock hanging off a prixod
 *    that officially never happened (#723's shape, one door over);
 *  - it left `current_batch_id` pointing at whatever truck the box was on
 *    when it went missing.
 */
export async function setBoxStatus(input: SetBoxStatusInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new BoxStatusError('unauthenticated');
  // Read on the pool BEFORE the transaction (#714): the void guard below
  // splits the base the way the engine would, and the engine needs it.
  const factor = input.to === 'void' ? Number(await getSetting('chargeable_weight_factor')) : 0;
  const result = await db.transaction(async (tx) => {
    // A void first locks every cost shared over the carton's lot, BEFORE the
    // carton itself (U20's race; the order is lockCostsTouchingLots' own
    // reason). The lot is read unlocked to find them — a box never changes lot.
    let costs: LockedCosts | null = null;
    if (input.to === 'void') {
      const [peek] = await tx
        .select({ lotId: boxes.lotId })
        .from(boxes)
        .where(eq(boxes.id, input.boxId));
      if (!peek) throw new BoxStatusError('box_not_found');
      costs = await lockCostsTouchingLots([peek.lotId], tx);
    }
    const rows = await tx.select().from(boxes).where(eq(boxes.id, input.boxId)).for('update');
    const box = rows[0];
    if (!box) throw new BoxStatusError('box_not_found');

    const allowed =
      (input.to !== 'in_stock' && box.status === 'in_stock') ||
      (input.to === 'in_stock' && box.status === 'lost');
    if (!allowed) throw new BoxStatusError('transition_not_allowed');
    if (box.crateId && input.to !== 'in_stock') throw new BoxStatusError('box_in_crate');

    // Money first (U20). A void takes the box out of every cost's base, and
    // where that leaves a live cost with nothing to split onto — the ONLY
    // live carton of a prixod that has its own customs, the last carton
    // aboard a truck or in a crate — the money would sit in the P&L on no box
    // and in no tannarx. voidReceipt has refused the prixod case since #530;
    // the box card was the door that let it through. Same code, same word.
    if (costs) {
      const orphan = await costOrphanedByVoid(costs, [box.id], factor, tx);
      if (orphan?.scope === 'receipt') throw new BoxStatusError('receipt_has_costs');
      if (orphan) throw new BoxStatusError('shared_cost_orphaned', orphan.code ?? undefined);
    }

    // A restored box lands by the warehouse's own rule, and only onto a
    // receipt that still stands.
    let restoredStatus: 'in_stock' | 'ready_for_pickup' = 'in_stock';
    // The warehouse it lands in: its own, or — lost on the road, so it has
    // none — the one the manager says it turned up at (the action authorises
    // the manager THERE). Never the truck's destination by default: a road
    // loss that turns up back in Yiwu must not land in Tashkent (U38).
    const landingWarehouseId = box.currentWarehouseId ?? input.foundAtWarehouseId ?? null;
    // Lost on the road and found back where its truck STARTED: it never rode
    // that truck, which is exactly `resolveMissing`'s `found_at_origin` — and
    // it is written as one, naming the truck, so the riders rule
    // (batches/riders.ts) takes it off the truck's freight and the cargo-risk
    // report can see a share a re-split has not yet moved. As a plain
    // «found» it kept the freight of a truck it never boarded and paid the
    // next truck's too, with no report able to name it. Found anywhere else
    // it did ride, and a restore changes no base.
    let foundBackOn: string | null = null;
    if (input.to === 'in_stock') {
      if (!landingWarehouseId) throw new BoxStatusError('box_has_no_warehouse');
      const [home] = await tx
        .select({ type: warehouses.type, active: warehouses.active })
        .from(warehouses)
        .where(eq(warehouses.id, landingWarehouseId));
      if (!home || (!box.currentWarehouseId && !home.active)) {
        throw new BoxStatusError('box_has_no_warehouse');
      }
      restoredStatus = landedStatusFor(home.type);
      if (!box.currentWarehouseId) {
        const truck = await roadLossTruck(box.id, tx);
        if (truck && truck.originWarehouseId === landingWarehouseId) foundBackOn = truck.id;
      }

      const [parent] = await tx
        .select({ status: receipts.status, voidedAt: receipts.voidedAt, warehouseId: receipts.warehouseId })
        .from(receiptLots)
        .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
        .where(eq(receiptLots.id, box.lotId));
      if (!parent) throw new BoxStatusError('box_not_found');
      // Restoring onto a voided prixod would mint stock the cost engine has
      // already stopped pricing — refused with a reason a person can act on,
      // never a silent success.
      if (parent.voidedAt || parent.status !== 'confirmed') {
        throw new BoxStatusError('receipt_voided');
      }
    }

    await tx
      .update(boxes)
      .set({
        status: input.to === 'in_stock' ? restoredStatus : input.to,
        statusReason: input.to === 'in_stock' ? null : input.reason,
        // The truck it was on when it vanished is over. Leaving the pointer
        // would put a live box back onto a batch's live membership.
        ...(input.to === 'in_stock'
          ? { currentBatchId: null, flags: [], currentWarehouseId: landingWarehouseId }
          : {}),
      })
      .where(eq(boxes.id, input.boxId));
    await tx.insert(boxMovements).values({
      boxId: box.id,
      fromWarehouseId: box.currentWarehouseId,
      toWarehouseId: input.to === 'in_stock' ? landingWarehouseId : box.currentWarehouseId,
      fromStatus: box.status,
      toStatus: input.to === 'in_stock' ? restoredStatus : input.to,
      cause: foundBackOn
        ? 'found_at_origin'
        : input.to === 'in_stock'
          ? 'found'
          : `marked_${input.to}`,
      refType: foundBackOn ? 'batch' : 'manual',
      refId: foundBackOn,
      actorId: ctx.actorId,
    });
    const auditWarehouseId = input.to === 'in_stock' ? landingWarehouseId : box.currentWarehouseId;
    await writeAudit(tx, { ...ctx, warehouseId: auditWarehouseId }, {
      entityType: 'box',
      entityId: box.id,
      action: 'status_change',
      before: { status: box.status, statusReason: box.statusReason },
      after: { status: input.to === 'in_stock' ? restoredStatus : input.to, reason: input.reason },
    });
    await emitEvent(tx, {
      type: 'BoxStatusChanged',
      payload: {
        boxId: box.id,
        shortCode: box.shortCode,
        from: box.status,
        to: input.to === 'in_stock' ? restoredStatus : input.to,
        reason: input.reason,
      },
      entityType: 'box',
      entityId: box.id,
      actorId: ctx.actorId,
    });
    return {
      from: box.status,
      to: input.to === 'in_stock' ? restoredStatus : input.to,
      lotId: box.lotId,
      foundBackOn,
    };
  });
  // A void box carries no cost share anywhere (#530/#849), so every cost that
  // was split over it re-splits onto the cargo that is real — the receipt's
  // own, the truck's freight, a crate's fee (editLot's precedent). AFTER the
  // commit: the engine reads settings and rates on the pool (#714), and money
  // must never be able to roll back a warehouse's status change. A failure is
  // logged, not thrown — the box IS void — and the nightly orphan sweep
  // (`recomputeAll({ orphaned })`) is the repair. `lost` moves no money: a
  // lost carton keeps its share (owner, 6a), and a restore changes no base —
  // except the road-lost carton found back at its truck's origin, which
  // leaves that truck's riders (resolveMissing's own tail, U17).
  if (input.to === 'void') {
    try {
      const { recomputeForLot } = await import('../costing/service');
      await recomputeForLot(result.lotId);
    } catch (error) {
      console.error('[box-status] recompute failed', input.boxId, error);
    }
  }
  if (result.foundBackOn) {
    const { recomputeRiderChange } = await import('../costing/service');
    await recomputeRiderChange([result.foundBackOn], 'restore_found_at_origin');
  }
  // A carton found on a prixod the client was COMPENSATED for (0105, Q6:
  // «sistema real hayotda bo'layotgan narsalarni aniqlasin»): the accountant
  // and the seller are told at once, or the client could collect the cargo
  // AND keep the money. After the commit and on the pool; the box IS
  // restored — a notice failure is logged, never rolled back into it.
  if (input.to === 'in_stock') {
    try {
      const { compensatedCargoFound } = await import('../finance/compensation');
      await compensatedCargoFound(input.boxId, ctx.actorId);
    } catch (error) {
      console.error('[box-status] compensation notice failed', input.boxId, error);
    }
  }
  // A write-off (lost or void) can be the deal's last outstanding carton —
  // the funnel's own ear hears only a handover, so the deal would park at
  // «qisman topshirildi» for good (U38's shape). A restore moves a deal
  // nowhere: stages only go forward.
  if (input.to !== 'in_stock') {
    try {
      const { advanceDealsAfterWriteOff } = await import('../deals/auto-stage');
      await advanceDealsAfterWriteOff([input.boxId], ctx);
    } catch (error) {
      console.error('[box-status] deal stage after a write-off failed', input.boxId, error);
    }
  }
  return { from: result.from, to: result.to };
}
