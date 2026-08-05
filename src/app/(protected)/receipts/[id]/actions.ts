'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { receipts } from '@/modules/platform/db/schema';
import { authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { VoidError, voidReceipt } from '@/modules/wms/receipts/service';
import { MoveError, moveReceipt } from '@/modules/wms/receipts/move';
import {
  ReturnError,
  returnToSenderSchema,
  returnUnclaimedToSender,
} from '@/modules/wms/unclaimed/return';

const voidSchema = z.object({
  receiptId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
});

export interface VoidReceiptState {
  ok?: boolean;
  error?: string;
}

export async function voidReceiptAction(
  _prev: VoidReceiptState,
  formData: FormData,
): Promise<VoidReceiptState> {
  const parsed = voidSchema.safeParse({
    receiptId: formData.get('receiptId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) return { error: 'validation' };

  const receipt = await db.query.receipts.findFirst({
    where: eq(receipts.id, parsed.data.receiptId),
  });
  if (!receipt) return { error: 'not_found' };

  const actor = await authorize('receipts.void', { warehouseId: receipt.warehouseId });
  const meta = await requestMeta();
  try {
    await voidReceipt(parsed.data.receiptId, parsed.data.reason, { actorId: actor.id, ...meta });
  } catch (err) {
    // A refusal, not a crash: the transaction rolled back and the receipt is
    // exactly as it was. NAMED, because a silent refusal reads as a broken
    // button — a box left the shelf, or the prixod still carries live costs
    // (money first, the batch-cancel rule).
    if (err instanceof VoidError) return { error: err.code };
    throw err;
  }
  revalidatePath(`/receipts/${parsed.data.receiptId}`);
  return { ok: true };
}

const moveSchema = z.object({
  receiptId: z.string().uuid(),
  toWarehouseId: z.string().uuid(),
});

/** Wrong-WH fix (edge case 15) — manager-level (receipts.void holders). */
export async function moveReceiptAction(
  input: unknown,
): Promise<{ ok: boolean; toCode?: string; error?: string }> {
  const parsed = moveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const receipt = await db.query.receipts.findFirst({
    where: eq(receipts.id, parsed.data.receiptId),
  });
  if (!receipt) return { ok: false, error: 'receipt_not_found' };
  const actor = await authorize('receipts.void', { warehouseId: receipt.warehouseId });
  const meta = await requestMeta();
  try {
    const result = await moveReceipt(parsed.data.receiptId, parsed.data.toWarehouseId, {
      actorId: actor.id,
      ...meta,
    });
    revalidatePath(`/receipts/${parsed.data.receiptId}`);
    return { ok: true, toCode: result.toCode };
  } catch (err) {
    if (err instanceof MoveError) return { ok: false, error: err.code };
    throw err;
  }
}

/** Unclaimed resolution — return the whole receipt to the sender (spec 6.7). */
export async function returnToSenderAction(
  input: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = returnToSenderSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const receipt = await db.query.receipts.findFirst({
    where: eq(receipts.id, parsed.data.receiptId),
  });
  if (!receipt) return { ok: false, error: 'receipt_not_found' };
  const actor = await authorize('receipts.unclaimed.resolve', {
    warehouseId: receipt.warehouseId,
  });
  const meta = await requestMeta();
  try {
    await returnUnclaimedToSender(parsed.data, { actorId: actor.id, ...meta });
    revalidatePath(`/receipts/${parsed.data.receiptId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof ReturnError) return { ok: false, error: err.code };
    throw err;
  }
}
