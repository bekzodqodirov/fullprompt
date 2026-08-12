import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  boxes,
  boxMovements,
  clients,
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
      | 'boxes_crated',
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
  const structuralChange =
    input.boxCount !== activeBoxes.length ||
    (lot.dimsMode === 'uniform' &&
      (input.boxLengthCm !== lot.boxLengthCm ||
        input.boxWidthCm !== lot.boxWidthCm ||
        input.boxHeightCm !== lot.boxHeightCm ||
        Number(input.boxWeightKg) !== Number(lot.boxWeightKg))) ||
    (lot.dimsMode === 'mixed' &&
      (Number(input.totalWeightKg) !== Number(lot.totalWeightKg) ||
        Number(input.totalVolumeM3) !== Number(lot.totalVolumeM3)));
  if (structuralChange && activeBoxes.some((b) => b.status !== 'in_stock')) {
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
    // phantom boxes' share. A grow redistributes the same way. Outside the
    // transaction on purpose: the engine re-reads the boxes it allocates
    // over, and money must not be able to roll back a warehouse's count fix.
    if (result.labelsToPrint > 0 || result.labelsToDestroy.length > 0) {
      const { recomputeAll } = await import('../costing/service');
      await recomputeAll({ receiptId: lot.receiptId });
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
  }

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
}

/** Most recent lots first for the stock table (helper reused by pages). */
export async function latestLotBoxStats(lotId: string) {
  return db
    .select()
    .from(boxes)
    .where(and(eq(boxes.lotId, lotId), eq(boxes.status, 'in_stock')))
    .orderBy(desc(boxes.seqInLot));
}
