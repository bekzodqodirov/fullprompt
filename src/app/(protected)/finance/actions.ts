'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  FinanceError,
  addTransaction,
  transactionSchema,
  voidTransaction,
} from '@/modules/wms/finance/service';

export interface TxFormState {
  ok?: boolean;
  error?: string;
}

export async function addTransactionAction(
  _prev: TxFormState,
  formData: FormData,
): Promise<TxFormState> {
  const parsed = transactionSchema.safeParse({
    clientId: formData.get('clientId'),
    type: formData.get('type'),
    amount: Number(String(formData.get('amount') ?? '').replace(',', '.')),
    currency: formData.get('currency'),
    method: formData.get('method') || undefined,
    txDate: formData.get('txDate'),
    batchId: formData.get('batchId') || undefined,
    note: String(formData.get('note') ?? ''),
  });
  if (!parsed.success) return { error: 'validation' };

  let actor;
  try {
    actor = await authorize('finance.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    await addTransaction(parsed.data, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof FinanceError) return { error: err.code };
    throw err;
  }
  revalidatePath('/finance');
  revalidatePath(`/finance/${parsed.data.clientId}`);
  if (parsed.data.batchId) revalidatePath(`/batches/${parsed.data.batchId}/pricing`);
  return { ok: true };
}

const voidSchema = z.object({
  id: z.string().uuid(),
  clientId: z.string().uuid(),
  reason: z.string().trim().min(2).max(500),
});

export async function voidTransactionAction(formData: FormData): Promise<void> {
  const parsed = voidSchema.safeParse({
    id: formData.get('id'),
    clientId: formData.get('clientId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) return;
  const actor = await authorize('finance.manage');
  const meta = await requestMeta();
  try {
    await voidTransaction(parsed.data.id, parsed.data.reason, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof FinanceError) return;
    throw err;
  }
  revalidatePath('/finance');
  revalidatePath(`/finance/${parsed.data.clientId}`);
}
