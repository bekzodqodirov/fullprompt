import { eq, inArray, sql } from 'drizzle-orm';
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

/**
 * FOR SHARE NOWAIT on the prixod row — 55P03 at once instead of a wait
 * (lock-rv2-3). Exported for the lot tarkibi save (`lot-composition.ts`),
 * which must hold the prixod's status still against a void or an annul for
 * the same reason the growth does.
 */
export async function lockReceiptShareNoWait(tx: Tx, receiptId: string): Promise<void> {
  await tx.execute(sql`SELECT 1 FROM receipts WHERE id = ${receiptId}::uuid FOR SHARE NOWAIT`);
}

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
  // cartons under a prixod voided a moment later (review lock-2). NOWAIT: a
  // count reaches this row only after it holds the lot's cartons, and a void
  // or annul holds this row and then waits for those cartons — waiting here
  // would close that cycle and postgres would kill one of the two, usually
  // the manager's void (review of the fixes, lock-rv2-3). Refused at once
  // instead; every count door answers 55P03 as «band, qaytadan bosing».
  // Raw, because drizzle spells the option «no wait», which postgres refuses.
  await lockReceiptShareNoWait(tx, lot.receiptId);
  const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, lot.receiptId));
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

  // The birth warehouse is key-shared BEFORE the code counter is bumped: the
  // cartons' foreign key would take it after, while a prixod confirmed at that
  // warehouse holds the row FOR UPDATE and then asks for the same counter —
  // one of the two killed (review of the fixes, lock-rv2-5). confirmReceipt's
  // order, warehouse then counter, is the one both follow now.
  await tx.execute(sql`SELECT 1 FROM warehouses WHERE id = ${a.warehouseId}::uuid FOR KEY SHARE`);
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

/**
 * The cartons a count press on THIS truck minted into this lot — named by the
 * growth's own audit row (`lotGrown.codes`), which is the only record of
 * «these cartons exist because the office typed a number». Read inside the
 * caller's transaction; the receipt's audit rows are few, found through the
 * (entity_type, entity_id) index.
 */
export async function grownCodesOnTruck(
  tx: Tx,
  a: { receiptId: string; lotId: string; batchId: string },
): Promise<Set<string>> {
  const rows = (await tx.execute(sql`
    SELECT jsonb_array_elements_text(al.after -> 'lotGrown' -> 'codes') AS code
      FROM audit_log al
     WHERE al.entity_type = 'receipt' AND al.entity_id = ${a.receiptId}::uuid
       AND al.after -> 'lotGrown' ->> 'lotId' = ${a.lotId}
       AND al.after -> 'lotGrown' ->> 'batchId' = ${a.batchId}
  `)) as unknown as { code: string }[];
  return new Set(rows.map((row) => row.code));
}

/**
 * The inverse of a growth (review money-1 / money-3): cartons a count press
 * minted and the office now takes back — a mistyped «50» for 5, or a dial
 * down after «52». They never existed, so they do not go back to a shelf:
 * they are voided (the lot form's own cause, `lot_edit_remove`) and the lot
 * shrinks by exactly their number of its own per-box figure — the mirror of
 * `growLotInTx`, so a dial up and back lands where it started, in kg and m³
 * and in every cost shared over the lot.
 *
 * The caller decides WHICH cartons (only ones its own truck minted, loose —
 * a sticker printed for a minted carton does not make it real, it dies with
 * it) and holds their rows locked; this re-checks the lot and
 * the prixod under their locks and does the arithmetic. The money re-split is
 * the caller's, after its commit (`afterLotGrown`).
 */
export async function shrinkGrownInTx(
  tx: Tx,
  a: {
    lotId: string;
    boxIds: string[];
    actorId: string;
    reason: string;
    batchId: string;
    side: 'load' | 'unload';
  },
): Promise<{ receiptId: string; codes: string[] }> {
  if (a.boxIds.length === 0) throw new GrowLotError('bad_count');
  const [lot] = await tx.select().from(receiptLots).where(eq(receiptLots.id, a.lotId)).for('update');
  if (!lot) throw new GrowLotError('lot_not_found');
  // NOWAIT for the same reason as the growth (lock-rv2-3).
  await lockReceiptShareNoWait(tx, lot.receiptId);
  const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, lot.receiptId));
  if (!receipt || receipt.status !== 'confirmed') throw new GrowLotError('receipt_not_confirmed');
  const grown = await grownCodesOnTruck(tx, { receiptId: receipt.id, lotId: lot.id, batchId: a.batchId });
  const rows = await tx
    .select({
      id: boxes.id,
      shortCode: boxes.shortCode,
      status: boxes.status,
      lotId: boxes.lotId,
      crateId: boxes.crateId,
    })
    .from(boxes)
    .where(inArray(boxes.id, a.boxIds));
  const takeable = rows.filter(
    (row) =>
      row.lotId === lot.id &&
      grown.has(row.shortCode) &&
      row.crateId === null &&
      ['loading', 'in_stock', 'ready_for_pickup'].includes(row.status),
  );
  if (takeable.length !== a.boxIds.length) throw new GrowLotError('not_grown_here');
  const n = takeable.length;
  const before = lot.boxCount;
  const after = before - n;
  if (after < 1) throw new GrowLotError('bad_count');
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
            totalWeightKg: (Number(lot.totalWeightKg) * after) / before,
            totalVolumeM3: (Number(lot.totalVolumeM3) * after) / before,
          },
          0,
        );
  for (const row of takeable) {
    await tx
      .update(boxes)
      .set({
        status: 'void',
        statusReason: 'count: prixoddan ortiqcha qaytarildi',
        currentBatchId: null,
        flags: [],
      })
      .where(eq(boxes.id, row.id));
  }
  await tx.insert(boxMovements).values(
    takeable.map((row) => ({
      boxId: row.id,
      fromStatus: row.status,
      toStatus: 'void',
      cause: 'lot_edit_remove',
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
  const codes = takeable.map((row) => row.shortCode);
  await writeAudit(tx, { actorId: a.actorId, warehouseId: receipt.warehouseId }, {
    entityType: 'receipt',
    entityId: receipt.id,
    action: 'update',
    before: {
      boxCount: before,
      totalWeightKg: Number(lot.totalWeightKg),
      totalVolumeM3: Number(lot.totalVolumeM3),
    },
    after: {
      boxCount: after,
      totalWeightKg: totals.totalWeightKg,
      totalVolumeM3: totals.totalVolumeM3,
      lotShrunk: {
        lotId: lot.id,
        letter: lot.letter,
        remove: n,
        reason: a.reason.trim(),
        batchId: a.batchId,
        side: a.side,
        codes,
      },
    },
  });
  return { receiptId: receipt.id, codes };
}
