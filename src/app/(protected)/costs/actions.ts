'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { batches, costEntries, receipts } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  addCostEntry,
  addReceiptCostsBulk,
  CostError,
  costEntrySchema,
  receiptCostGridSchema,
  voidCostEntry,
} from '@/modules/wms/costing/service';

export interface CostActionResult {
  ok: boolean;
  error?: string;
}

export async function addCostEntryAction(input: unknown): Promise<CostActionResult> {
  const parsed = costEntrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };

  let path: string;
  let actor;
  try {
    if (parsed.data.scope === 'batch') {
      const batch = await db.query.batches.findFirst({
        where: eq(batches.id, parsed.data.batchId!),
      });
      if (!batch) return { ok: false, error: 'not_found' };
      actor = await authorize('costs.enter_batch', { warehouseId: batch.originWarehouseId });
      path = `/batches/${batch.id}`;
    } else {
      const receipt = await db.query.receipts.findFirst({
        where: eq(receipts.id, parsed.data.receiptId!),
      });
      if (!receipt) return { ok: false, error: 'not_found' };
      actor = await authorize('costs.enter_receipt', { warehouseId: receipt.warehouseId });
      path = `/receipts/${receipt.id}`;
    }
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }

  const meta = await requestMeta();
  try {
    await addCostEntry(parsed.data, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof CostError) return { ok: false, error: err.code };
    throw err;
  }
  revalidatePath(path);
  return { ok: true };
}

/**
 * The receipt-cost grid's one save (round 29). Gated like the batch costs
 * panel — the person doing customs at the batch — and the service re-proves
 * every receipt's membership before a single entry is written.
 */
export async function saveReceiptCostGridAction(input: unknown): Promise<CostActionResult> {
  const parsed = receiptCostGridSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };

  const batch = await db.query.batches.findFirst({ where: eq(batches.id, parsed.data.batchId) });
  if (!batch) return { ok: false, error: 'not_found' };
  let actor;
  try {
    actor = await authorize('costs.enter_batch', { warehouseId: batch.originWarehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }

  const meta = await requestMeta();
  try {
    await addReceiptCostsBulk(parsed.data, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof CostError) return { ok: false, error: err.code };
    throw err;
  }
  revalidatePath(`/batches/${batch.id}`);
  return { ok: true };
}

const voidSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().trim().min(2).max(500),
});

export async function voidCostEntryAction(input: unknown): Promise<CostActionResult> {
  const parsed = voidSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };

  const entry = await db.query.costEntries.findFirst({
    where: eq(costEntries.id, parsed.data.id),
  });
  if (!entry) return { ok: false, error: 'not_found' };

  let actor;
  try {
    if (entry.scope === 'batch' && entry.batchId) {
      const batch = await db.query.batches.findFirst({ where: eq(batches.id, entry.batchId) });
      actor = await authorize('costs.enter_batch', { warehouseId: batch?.originWarehouseId });
    } else {
      const receipt = entry.receiptId
        ? await db.query.receipts.findFirst({ where: eq(receipts.id, entry.receiptId) })
        : null;
      actor = await authorize('costs.enter_receipt', { warehouseId: receipt?.warehouseId });
    }
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }

  const meta = await requestMeta();
  try {
    await voidCostEntry(parsed.data.id, parsed.data.reason, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof CostError) return { ok: false, error: err.code };
    throw err;
  }
  if (entry.batchId) revalidatePath(`/batches/${entry.batchId}`);
  if (entry.receiptId) revalidatePath(`/receipts/${entry.receiptId}`);
  return { ok: true };
}
