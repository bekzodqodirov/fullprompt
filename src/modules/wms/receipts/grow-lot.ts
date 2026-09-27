import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../../platform/db/client';
import { boxes, boxMovements, receiptLots, receipts, warehouses } from '../../platform/db/schema';
import { writeAudit } from '../../platform/audit/service';
import { nextBoxCodes } from '../codes';
import { computeLotTotals } from './math';

/**
 * «Prixoddan ortiq karobka» (0112, the owner's Q3b: «asl prixod sonini
 * oshirish uchun yangi qoida»): the office counted more cartons of a lot than
 * the prixod ever listed — 52 on a truck, 50 on the paper — and every carton
 * the lot owned is already accounted for. The count grows the LOT, so the
 * extra cartons are this client's cargo with codes of their own, instead of
 * a second prixod nobody asked for.
 *
 * `editLot` cannot do it: it refuses a count change once any carton has left
 * the shelf, because a person typing a number must not mint boxes that are
 * physically somewhere. Here a count door is the witness — the person
 * standing at the truck said «there are two more» — and the reason is
 * mandatory and recorded.
 *
 * Inside the caller's transaction (the count press), and the lot row is
 * locked first, so two presses cannot mint the same sequence numbers. The
 * new cartons are born where the truck's cargo came from (`warehouseId`),
 * `in_stock`, written against the receipt with the same cause a lot edit
 * uses (`lot_edit_add`), so every reader of «how did this carton come into
 * being» already knows the answer. The lot's kg and m³ grow by the per-box
 * figure (the uniform dims, or the lot's own average when it was weighed
 * whole). The money re-split is the caller's, AFTER its commit
 * (`recomputeForLot`, #714).
 */
export class GrowLotError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export const GROW_LOT_MAX = 1000;

export async function growLotInTx(
  tx: Tx,
  a: {
    lotId: string;
    add: number;
    warehouseId: string;
    actorId: string;
    reason: string;
    batchId: string;
    side: 'load' | 'unload';
  },
): Promise<{ receiptId: string; boxes: { id: string; shortCode: string }[] }> {
  if (!Number.isInteger(a.add) || a.add < 1 || a.add > GROW_LOT_MAX) throw new GrowLotError('bad_count');
  const reason = a.reason.trim();
  if (reason.length < 3) throw new GrowLotError('reason_required');

  const [lot] = await tx.select().from(receiptLots).where(eq(receiptLots.id, a.lotId)).for('update');
  if (!lot) throw new GrowLotError('lot_not_found');
  // A voided prixod never happened; growing it would mint live cargo off it
  // (#723's shape, one door over). FOR SHARE, so the answer holds until the
  // growth commits: the super-admin's annul locks this row first and voids
  // only the cartons it saw, and a growth read unlocked could land two live
  // cartons under a prixod voided a moment later (review lock-2) — now the
  // two meet on this row and one of them waits or is told «band».
  const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, lot.receiptId)).for('share');
  if (!receipt || receipt.status !== 'confirmed') throw new GrowLotError('receipt_not_confirmed');
  const [home] = await tx.select().from(warehouses).where(eq(warehouses.id, receipt.warehouseId));

  const [counts] = await tx
    .select({
      active: sql<number>`count(*) FILTER (WHERE ${boxes.status} <> 'void')`,
      maxSeq: sql<number>`coalesce(max(${boxes.seqInLot}), 0)`,
    })
    .from(boxes)
    .where(eq(boxes.lotId, lot.id));
  // The divisor every reader uses is the lot's own `box_count` — the costing
  // engine's per-box figure is total ÷ box_count, and a carton voided on the
  // box card leaves box_count alone. Growing by the ACTIVE count re-weighed
  // every carton of the lot, cartons on earlier, already-costed trucks
  // included (review money-2: 10 → 11.1 kg a carton after one void). So the
  // lot grows by exactly `add` of its own per-box figure and nothing else of
  // it moves.
  const before = lot.boxCount;
  const after = before + a.add;
  const totals =
    lot.dimsMode === 'uniform' &&
    lot.boxLengthCm !== null &&
    lot.boxWidthCm !== null &&
    lot.boxHeightCm !== null &&
    lot.boxWeightKg !== null
      ? computeLotTotals(
          {
            dimsMode: 'uniform',
            boxCount: after,
            boxLengthCm: lot.boxLengthCm,
            boxWidthCm: lot.boxWidthCm,
            boxHeightCm: lot.boxHeightCm,
            boxWeightKg: Number(lot.boxWeightKg),
          },
          0,
        )
      : computeLotTotals(
          {
            dimsMode: 'mixed',
            boxCount: after,
            // A lot weighed whole has no per-box figure but its own average.
            totalWeightKg: before > 0 ? (Number(lot.totalWeightKg) * after) / before : Number(lot.totalWeightKg),
            totalVolumeM3: before > 0 ? (Number(lot.totalVolumeM3) * after) / before : Number(lot.totalVolumeM3),
          },
          0,
        );

  // Codes carry the RECEIPT's warehouse prefix, like every carton of the lot.
  const codes = await nextBoxCodes(tx, home!, a.add);
  const inserted = await tx
    .insert(boxes)
    .values(
      codes.map((shortCode, idx) => ({
        lotId: lot.id,
        shortCode,
        seqInLot: Number(counts!.maxSeq) + idx + 1,
        status: 'in_stock',
        currentWarehouseId: a.warehouseId,
      })),
    )
    .returning({ id: boxes.id, shortCode: boxes.shortCode });
  await tx.insert(boxMovements).values(
    inserted.map((b) => ({
      boxId: b.id,
      toWarehouseId: a.warehouseId,
      toStatus: 'in_stock',
      cause: 'lot_edit_add',
      refType: 'receipt',
      refId: receipt.id,
      actorId: a.actorId,
    })),
  );
  await tx
    .update(receiptLots)
    .set({
      boxCount: after,
      totalWeightKg: totals.totalWeightKg.toString(),
      totalVolumeM3: totals.totalVolumeM3.toString(),
    })
    .where(eq(receiptLots.id, lot.id));
  await writeAudit(tx, { actorId: a.actorId, warehouseId: receipt.warehouseId }, {
    entityType: 'receipt',
    entityId: receipt.id,
    action: 'update',
    before: {
      boxCount: before,
      liveBoxes: Number(counts!.active),
      totalWeightKg: Number(lot.totalWeightKg),
      totalVolumeM3: Number(lot.totalVolumeM3),
    },
    after: {
      boxCount: after,
      totalWeightKg: totals.totalWeightKg,
      totalVolumeM3: totals.totalVolumeM3,
      lotGrown: {
        lotId: lot.id,
        letter: lot.letter,
        add: a.add,
        reason,
        batchId: a.batchId,
        side: a.side,
        codes: inserted.map((b) => b.shortCode),
      },
    },
  });
  return { receiptId: receipt.id, boxes: inserted };
}

/**
 * After the count's commit: the lot's cartons changed, so every cost shared
 * over them re-splits now — the same net `editLot` casts (a failure is logged
 * and queued, never thrown at a count that has already happened).
 */
export async function afterLotGrown(lotId: string): Promise<void> {
  try {
    const { recomputeForLot } = await import('../costing/service');
    await recomputeForLot(lotId);
  } catch (error) {
    console.error('[lot-grow] recompute failed, queued for retry', lotId, error);
    try {
      const { enqueue, JOB_RECOMPUTE_COSTS } = await import('../../platform/jobs/boss');
      await enqueue(JOB_RECOMPUTE_COSTS, { lotId });
    } catch (queueError) {
      console.error('[lot-grow] recompute retry could not be queued', lotId, queueError);
    }
  }
}
