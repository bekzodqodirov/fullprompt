'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { receiptLots, receipts } from '@/modules/platform/db/schema';
import { AuthError, authorize, type Actor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { enqueue, JOB_PROCESS_EVENTS } from '@/modules/platform/jobs/boss';
import {
  assignReceiptClient,
  EditError,
  editLot,
  editLotSchema,
  setLotQrSkipped,
  receivedEditSchema,
  setReceiptReceived,
  type LotEditResult,
} from '@/modules/wms/receipts/edit';
import { isBusyError, isServerBehind } from '@/modules/platform/db/errors';

export interface EditLotState {
  ok?: boolean;
  error?: string;
  reconciliation?: LotEditResult;
}

export async function editLotAction(_prev: EditLotState, formData: FormData): Promise<EditLotState> {
  const num = (name: string) => {
    const v = formData.get(name);
    return v === null || v === '' ? undefined : Number(v);
  };
  const parsed = editLotSchema.safeParse({
    lotId: formData.get('lotId'),
    productNameZh: formData.get('productNameZh'),
    productNameRu: formData.get('productNameRu') ?? '',
    boxCount: num('boxCount'),
    boxLengthCm: num('boxLengthCm'),
    boxWidthCm: num('boxWidthCm'),
    boxHeightCm: num('boxHeightCm'),
    boxWeightKg: num('boxWeightKg'),
    totalWeightKg: num('totalWeightKg'),
    totalVolumeM3: num('totalVolumeM3'),
    note: formData.get('note') ?? '',
  });
  if (!parsed.success) return { error: 'validation' };

  const lot = await db.query.receiptLots.findFirst({
    where: eq(receiptLots.id, parsed.data.lotId),
  });
  if (!lot) return { error: 'not_found' };
  const receipt = (await db.query.receipts.findFirst({ where: eq(receipts.id, lot.receiptId) }))!;

  let actor: Actor;
  try {
    actor = await authorize('receipts.edit', { warehouseId: receipt.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();

  try {
    const reconciliation = await editLot(parsed.data, actor, { actorId: actor.id, ...meta });
    revalidatePath(`/receipts/${receipt.id}`);
    return { ok: true, reconciliation };
  } catch (err) {
    if (err instanceof EditError) return { error: err.code };
    // A count press held the lot at that moment — the form's own word for
    // «somebody changed it, look again», never the error page (lock-rv2-4).
    if (isBusyError(err)) return { error: 'lot_changed' };
    throw err;
  }
}

/**
 * The office receipt's correction (0112, Q9 b): who received it, which day.
 * Authorised at the receipt's warehouse like `editLotAction`; the SERVICE asks
 * the count door and the entry day again (`mayCorrectReceived`), so a posted
 * id for a prixod the screen would not have offered is still refused.
 */
export async function setReceivedAction(input: unknown): Promise<{ ok?: boolean; error?: string }> {
  const parsed = receivedEditSchema.safeParse(input);
  if (!parsed.success) return { error: 'validation' };
  const receipt = await db.query.receipts.findFirst({
    where: eq(receipts.id, parsed.data.receiptId),
  });
  if (!receipt) return { error: 'not_found' };
  let actor: Actor;
  try {
    actor = await authorize('plans.manage', { warehouseId: receipt.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    await setReceiptReceived(parsed.data, actor, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof EditError) return { error: err.code };
    // Deploy morning (#472): 0112's columns may not exist yet.
    if (isServerBehind(err)) {
      console.error('[receipt-received] server behind', err);
      return { error: 'server_behind' };
    }
    throw err;
  }
  revalidatePath(`/receipts/${receipt.id}`);
  return { ok: true };
}

const assignSchema = z.object({
  receiptId: z.string().uuid(),
  clientId: z.string().uuid(),
});

export interface AssignClientState {
  error?: string;
}

export async function assignClientAction(
  _prev: AssignClientState,
  formData: FormData,
): Promise<AssignClientState> {
  const parsed = assignSchema.safeParse({
    receiptId: formData.get('receiptId'),
    clientId: formData.get('clientId'),
  });
  if (!parsed.success) return {};

  const receipt = await db.query.receipts.findFirst({
    where: eq(receipts.id, parsed.data.receiptId),
  });
  if (!receipt) return {};

  const actor = await authorize('receipts.unclaimed.resolve', {
    warehouseId: receipt.warehouseId,
  });
  const meta = await requestMeta();
  try {
    await assignReceiptClient(parsed.data.receiptId, parsed.data.clientId, {
      actorId: actor.id,
      ...meta,
    });
  } catch (err) {
    // The crated-cargo refusal must reach the screen — a silent no-op here
    // reads as "changed" to the person pressing the button.
    if (err instanceof EditError) return { error: err.code };
    throw err;
  }
  await enqueue(JOB_PROCESS_EVENTS, {});
  revalidatePath(`/receipts/${parsed.data.receiptId}`);
  return {};
}

const qrSkipSchema = z.object({ lotId: z.string().uuid(), skipped: z.boolean() });

/**
 * «QR yopishtirilmadi» on the receipt card (0112). The lot form's door —
 * `receipts.edit` at the receipt's warehouse — and the service decides the
 * rest (same-day creator or a manager; a manager once cartons have left).
 */
export async function setLotQrSkippedAction(
  input: unknown,
): Promise<{ ok: boolean; error?: string; reverted?: number }> {
  const parsed = qrSkipSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const lot = await db.query.receiptLots.findFirst({ where: eq(receiptLots.id, parsed.data.lotId) });
  if (!lot) return { ok: false, error: 'not_found' };
  const receipt = (await db.query.receipts.findFirst({ where: eq(receipts.id, lot.receiptId) }))!;
  let actor: Actor;
  try {
    actor = await authorize('receipts.edit', { warehouseId: receipt.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    const result = await setLotQrSkipped(parsed.data, actor, { actorId: actor.id, ...meta });
    revalidatePath(`/receipts/${receipt.id}`);
    return { ok: true, reverted: result.reverted };
  } catch (err) {
    if (err instanceof EditError) return { ok: false, error: err.code };
    if (isBusyError(err)) return { ok: false, error: 'busy_retry' };
    throw err;
  }
}
