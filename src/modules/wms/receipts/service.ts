import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  attachments,
  boxes,
  boxMovements,
  clients,
  costEntries,
  productDictionary,
  receiptLots,
  receipts,
  warehouses,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';
import { getSetting } from '../../platform/settings/service';
import { assignLetters } from '../sequencer';
import { nextBoxCodes, nextReceiptNumber } from '../codes';
import { computeLotTotals } from './math';

export const lotInputSchema = z
  .object({
    id: z.string().uuid(), // client-generated: attachments are pre-bound to it
    productNameZh: z.string().trim().min(1).max(300),
    productNameRu: z.string().trim().max(300).optional().or(z.literal('')),
    boxCount: z.number().int().min(1).max(10_000),
    dimsMode: z.enum(['uniform', 'mixed']),
    boxLengthCm: z.number().int().min(1).max(1000).optional(),
    boxWidthCm: z.number().int().min(1).max(1000).optional(),
    boxHeightCm: z.number().int().min(1).max(1000).optional(),
    boxWeightKg: z.number().min(0.001).max(10_000).optional(),
    totalWeightKg: z.number().min(0.001).max(1_000_000).optional(),
    totalVolumeM3: z.number().min(0.0001).max(10_000).optional(),
  })
  .refine(
    (lot) =>
      lot.dimsMode === 'uniform'
        ? lot.boxLengthCm && lot.boxWidthCm && lot.boxHeightCm && lot.boxWeightKg
        : lot.totalWeightKg && lot.totalVolumeM3,
    { message: 'dims incomplete for mode' },
  );

export const extraCostSchema = z.object({
  costTypeId: z.string().uuid(),
  amount: z.number().min(0.01).max(100_000_000),
  currency: z.string().length(3),
  note: z.string().trim().max(500).optional().or(z.literal('')),
});

export const confirmReceiptSchema = z.object({
  receiptId: z.string().uuid(), // client-generated (idempotency + attachment pre-binding)
  warehouseId: z.string().uuid(),
  clientId: z.string().uuid().nullable(), // null ⇒ unclaimed intake
  sourceNote: z.string().trim().max(500).optional().or(z.literal('')),
  lots: z.array(lotInputSchema).min(1).max(50),
  extraCosts: z.array(extraCostSchema).max(20).default([]),
});

export type ConfirmReceiptInput = z.infer<typeof confirmReceiptSchema>;

export class ReceiptError extends Error {
  constructor(
    public readonly code:
      | 'warehouse_not_found'
      | 'client_not_found'
      | 'photo_required'
      | 'already_confirmed',
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface ConfirmedLotSummary {
  lotId: string;
  letter: string;
  productNameZh: string;
  productNameRu: string | null;
  boxCount: number;
  totalWeightKg: number;
  totalVolumeM3: number;
}

/**
 * The W1 confirm transaction (spec 6.1 step 5): assigns letters under the
 * warehouse lock, generates boxes with short codes, writes movements, emits
 * `ReceiptConfirmed`. Idempotent by the client-generated receipt id — a retry
 * (offline sync, double tap) returns the already-confirmed receipt.
 */
export async function confirmReceipt(
  input: ConfirmReceiptInput,
  ctx: AuditContext,
): Promise<{ receiptId: string; number: string; lots: ConfirmedLotSummary[]; alreadyConfirmed: boolean }> {
  const existing = await db.query.receipts.findFirst({
    where: eq(receipts.id, input.receiptId),
  });
  if (existing) {
    const lots = await confirmedLotSummaries(input.receiptId);
    return { receiptId: existing.id, number: existing.number!, lots, alreadyConfirmed: true };
  }

  const warehouse = await db.query.warehouses.findFirst({
    where: eq(warehouses.id, input.warehouseId),
  });
  if (!warehouse) throw new ReceiptError('warehouse_not_found');

  if (input.clientId) {
    const client = await db.query.clients.findFirst({ where: eq(clients.id, input.clientId) });
    if (!client) throw new ReceiptError('client_not_found');
  }

  // Min-1-photo per lot (spec 6.1): attachments were uploaded against the
  // client-generated lot ids before confirm.
  const lotIds = input.lots.map((l) => l.id);
  const photoRows = await db
    .select({ entityId: attachments.entityId, n: sql<number>`count(*)` })
    .from(attachments)
    .where(
      sql`${attachments.entityType} = 'receipt_lot' AND ${attachments.entityId} IN ${lotIds} AND ${attachments.kind} = 'photo'`,
    )
    .groupBy(attachments.entityId);
  const photoCounts = new Map(photoRows.map((r) => [r.entityId, Number(r.n)]));
  for (const lot of input.lots) {
    if (!photoCounts.get(lot.id)) throw new ReceiptError('photo_required', lot.productNameZh);
  }

  const chargeableFactor = await getSetting('chargeable_weight_factor');

  const result = await db.transaction(async (tx) => {
    const number = await nextReceiptNumber(tx, warehouse);
    const [receipt] = await tx
      .insert(receipts)
      .values({
        id: input.receiptId,
        number,
        warehouseId: warehouse.id,
        clientId: input.clientId,
        status: 'confirmed',
        sourceNote: input.sourceNote || null,
        createdBy: ctx.actorId!,
        confirmedAt: new Date(),
        confirmedBy: ctx.actorId,
        clientEventUuid: input.receiptId,
      })
      .returning();

    const letters = await assignLetters(tx, warehouse.id, input.lots.length);

    const summaries: ConfirmedLotSummary[] = [];
    for (const [i, lotInput] of input.lots.entries()) {
      const totals = computeLotTotals(
        lotInput.dimsMode === 'uniform'
          ? {
              dimsMode: 'uniform',
              boxCount: lotInput.boxCount,
              boxLengthCm: lotInput.boxLengthCm!,
              boxWidthCm: lotInput.boxWidthCm!,
              boxHeightCm: lotInput.boxHeightCm!,
              boxWeightKg: lotInput.boxWeightKg!,
            }
          : {
              dimsMode: 'mixed',
              boxCount: lotInput.boxCount,
              totalWeightKg: lotInput.totalWeightKg!,
              totalVolumeM3: lotInput.totalVolumeM3!,
            },
        chargeableFactor,
      );
      const assignment = letters[i]!;

      const [lot] = await tx
        .insert(receiptLots)
        .values({
          id: lotInput.id,
          receiptId: receipt!.id,
          seq: i + 1,
          letter: assignment.letter,
          cycleNo: assignment.cycleNo,
          productNameZh: lotInput.productNameZh,
          productNameRu: lotInput.productNameRu || null,
          boxCount: lotInput.boxCount,
          dimsMode: lotInput.dimsMode,
          boxLengthCm: lotInput.boxLengthCm ?? null,
          boxWidthCm: lotInput.boxWidthCm ?? null,
          boxHeightCm: lotInput.boxHeightCm ?? null,
          boxWeightKg: lotInput.boxWeightKg?.toString() ?? null,
          totalWeightKg: totals.totalWeightKg.toString(),
          totalVolumeM3: totals.totalVolumeM3.toString(),
        })
        .returning();

      const codes = await nextBoxCodes(tx, warehouse, lotInput.boxCount);
      const boxRows = codes.map((shortCode, idx) => ({
        lotId: lot!.id,
        shortCode,
        seqInLot: idx + 1,
        status: 'in_stock',
        currentWarehouseId: warehouse.id,
      }));
      const insertedBoxes = await tx
        .insert(boxes)
        .values(boxRows)
        .returning({ id: boxes.id });
      await tx.insert(boxMovements).values(
        insertedBoxes.map((b) => ({
          boxId: b.id,
          toWarehouseId: warehouse.id,
          fromStatus: null,
          toStatus: 'in_stock',
          cause: 'receipt',
          refType: 'receipt',
          refId: receipt!.id,
          actorId: ctx.actorId,
        })),
      );

      // Grow the product dictionary from real usage (spec §8).
      await tx
        .insert(productDictionary)
        .values({
          zh: lotInput.productNameZh,
          ru: lotInput.productNameRu || null,
          usageCount: 1,
          source: 'manual',
        })
        .onConflictDoUpdate({
          target: productDictionary.zh,
          set: {
            usageCount: sql`${productDictionary.usageCount} + 1`,
            ru: sql`COALESCE(${productDictionary.ru}, ${lotInput.productNameRu || null})`,
          },
        });

      summaries.push({
        lotId: lot!.id,
        letter: assignment.letter,
        productNameZh: lotInput.productNameZh,
        productNameRu: lotInput.productNameRu || null,
        boxCount: lotInput.boxCount,
        totalWeightKg: totals.totalWeightKg,
        totalVolumeM3: totals.totalVolumeM3,
      });
    }

    for (const cost of input.extraCosts) {
      await tx.insert(costEntries).values({
        scope: 'receipt',
        receiptId: receipt!.id,
        costTypeId: cost.costTypeId,
        amount: cost.amount.toString(),
        currency: cost.currency,
        costDate: new Date().toISOString().slice(0, 10),
        note: cost.note || null,
        enteredBy: ctx.actorId!,
      });
    }

    await writeAudit(tx, { ...ctx, warehouseId: warehouse.id }, {
      entityType: 'receipt',
      entityId: receipt!.id,
      action: 'create',
      after: {
        number,
        client: input.clientId,
        lots: summaries.map((s) => ({ letter: s.letter, zh: s.productNameZh, boxes: s.boxCount })),
      },
    });

    await emitEvent(tx, {
      type: input.clientId ? 'ReceiptConfirmed' : 'UnknownCargoReceived',
      payload: {
        receiptId: receipt!.id,
        number,
        warehouseId: warehouse.id,
        warehouseCode: warehouse.code,
        clientId: input.clientId,
        lots: summaries,
      },
      entityType: 'receipt',
      entityId: receipt!.id,
      actorId: ctx.actorId,
    });

    return { receiptId: receipt!.id, number: number, lots: summaries };
  });

  return { ...result, alreadyConfirmed: false };
}

async function confirmedLotSummaries(receiptId: string): Promise<ConfirmedLotSummary[]> {
  const rows = await db
    .select()
    .from(receiptLots)
    .where(eq(receiptLots.receiptId, receiptId))
    .orderBy(receiptLots.seq);
  return rows.map((lot) => ({
    lotId: lot.id,
    letter: lot.letter ?? '?',
    productNameZh: lot.productNameZh,
    productNameRu: lot.productNameRu,
    boxCount: lot.boxCount,
    totalWeightKg: Number(lot.totalWeightKg),
    totalVolumeM3: Number(lot.totalVolumeM3),
  }));
}

/** Void a receipt (nothing is deleted; letters are NOT returned, spec 5.3). */
export async function voidReceipt(
  receiptId: string,
  reason: string,
  ctx: AuditContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    const receipt = await tx.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
    if (!receipt || receipt.voidedAt) return;

    await tx
      .update(receipts)
      .set({ status: 'voided', voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason })
      .where(eq(receipts.id, receiptId));

    const lotRows = await tx
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .where(eq(receiptLots.receiptId, receiptId));
    const lotIds = lotRows.map((l) => l.id);
    if (lotIds.length) {
      const boxRows = await tx
        .select({ id: boxes.id, status: boxes.status })
        .from(boxes)
        .where(inArray(boxes.lotId, lotIds));
      await tx
        .update(boxes)
        .set({ status: 'void', statusReason: `receipt voided: ${reason}` })
        .where(inArray(boxes.lotId, lotIds));
      await tx.insert(boxMovements).values(
        boxRows.map((b) => ({
          boxId: b.id,
          fromStatus: b.status,
          toStatus: 'void',
          cause: 'receipt_void',
          refType: 'receipt',
          refId: receiptId,
          actorId: ctx.actorId,
        })),
      );
    }

    await writeAudit(tx, { ...ctx, warehouseId: receipt.warehouseId }, {
      entityType: 'receipt',
      entityId: receiptId,
      action: 'void',
      after: { reason },
    });
  });
}
