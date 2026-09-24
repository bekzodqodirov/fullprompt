'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  FinanceError,
  addTransaction,
  placePayment,
  transactionSchema,
  voidTransaction,
} from '@/modules/wms/finance/service';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';

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
    // «1,200» is a thousand two hundred, not $1.20, and «1 200» is not NaN —
    // the calc screen's reader, now at every price and payment door (the
    // truck pricing form posts here).
    amount: parseTypedMoney(String(formData.get('amount') ?? '')) ?? Number.NaN,
    currency: formData.get('currency'),
    method: formData.get('method') || undefined,
    txDate: formData.get('txDate'),
    batchId: formData.get('batchId') || undefined,
    // The deal this money answers, when the accountant said. Load-bearing for
    // deferrals: the #251 netting joins payments to the deferred deal BY THIS
    // COLUMN, and until the form could send it, no payment ever carried one —
    // so a paid-off deferral went on excusing unrelated debt at the handover
    // gate, exactly what #251 was written to stop.
    dealId: formData.get('dealId') || undefined,
    accountId: formData.get('accountId') || undefined,
    note: String(formData.get('note') ?? ''),
  });
  if (!parsed.success) return { error: 'validation' };
  // A payment names the cash box it landed in (audit A2). One saved with none
  // took its amount off the Balans receivable and put it in no kassa, so the
  // net fell by the payment while the cash flow said it came in — and no
  // screen could place it afterwards. The rule lives at this door, the only
  // one that takes a typed payment: rows entered before cash boxes existed
  // have none, and the service still reads them (#171's history rule).
  if (parsed.data.type === 'payment' && !parsed.data.accountId) return { error: 'account_required' };
  // A refund is money LEAVING a kassa (R6a) — the same door as every other
  // kassa outflow, and never a row without the box it left.
  if (parsed.data.type === 'refund' && !parsed.data.accountId) return { error: 'account_required' };

  let actor;
  try {
    actor = await authorize('finance.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  // Handing cash back opens a till, and tills are the accountant's and the
  // admin's (`finance.expenses`, the kassa screens' own door) — the VED holds
  // finance.manage and prices jobs, but does not pay money out of a drawer.
  if (parsed.data.type === 'refund' && !actor.permissions.has('finance.expenses')) {
    return { error: 'forbidden' };
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

/** The register's «kassaga joylash» — see `placePayment` (audit A2). */
export async function placePaymentAction(formData: FormData): Promise<void> {
  const id = z.string().uuid().safeParse(formData.get('id'));
  const accountId = z.string().uuid().safeParse(formData.get('accountId'));
  if (!id.success || !accountId.success) return;
  const actor = await authorize('finance.manage');
  const meta = await requestMeta();
  try {
    await placePayment(id.data, accountId.data, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof FinanceError) return;
    throw err;
  }
  revalidatePath('/finance/reestr');
  revalidatePath('/accounting/balance');
  revalidatePath('/accounting');
}
