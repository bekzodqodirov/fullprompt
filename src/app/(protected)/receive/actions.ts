'use server';

import { AuthError, authorize, type Actor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { enqueue, JOB_PROCESS_EVENTS } from '@/modules/platform/jobs/boss';
import {
  confirmReceipt,
  confirmReceiptSchema,
  ReceiptError,
} from '@/modules/wms/receipts/service';
import {
  ExpenseRequestError,
  expenseRequestSchema,
  requestExpense,
} from '@/modules/wms/accounting/expense-requests';

export interface SubmitReceiptResult {
  ok: boolean;
  receiptId?: string;
  number?: string;
  lots?: { lotId: string; letter: string; productNameZh: string; boxCount: number }[];
  error?: string;
  detail?: string;
}

export async function submitReceiptAction(input: unknown): Promise<SubmitReceiptResult> {
  const parsed = confirmReceiptSchema.safeParse(input);
  if (!parsed.success) {
    // Tell the operator WHICH field failed, not just "validation".
    const issue = parsed.error.issues[0];
    const detail = issue ? `${issue.path.join('.')}: ${issue.message}` : undefined;
    return { ok: false, error: 'validation', detail };
  }

  // A thrown AuthError would crash the page with a raw digest — return a
  // result the wizard can show instead (seen with a warehouse-scoped operator
  // whose stale draft pointed at another warehouse).
  let actor: Actor;
  try {
    actor = await authorize('receipts.create', { warehouseId: parsed.data.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'warehouse_forbidden' };
    throw err;
  }
  const meta = await requestMeta();

  try {
    const result = await confirmReceipt(parsed.data, { actorId: actor.id, ...meta });
    // Fire the notification fan-out immediately (workers also sweep per minute).
    await enqueue(JOB_PROCESS_EVENTS, {});
    return {
      ok: true,
      receiptId: result.receiptId,
      number: result.number,
      lots: result.lots.map((l) => ({
        lotId: l.lotId,
        letter: l.letter,
        productNameZh: l.productNameZh,
        boxCount: l.boxCount,
      })),
    };
  } catch (err) {
    if (err instanceof ReceiptError) return { ok: false, error: err.code };
    throw err;
  }
}

/**
 * The rasxod xabari (round 107, item 5). Same gate and scope as the screen
 * it sits on: `receipts.create` AT the named warehouse — a bare authorize
 * would let a scoped operator post a foreign warehouse's uuid (#514).
 */
export async function requestExpenseAction(
  input: unknown,
): Promise<{ ok?: boolean; error?: string }> {
  const parsed = expenseRequestSchema.safeParse(input);
  if (!parsed.success) return { error: 'validation' };
  let actor: Actor;
  try {
    actor = await authorize('receipts.create', { warehouseId: parsed.data.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    await requestExpense(parsed.data, { actorId: actor.id, ...meta });
    // The ping should not wait for the per-minute sweep.
    await enqueue(JOB_PROCESS_EVENTS, {}).catch(() => {});
    return { ok: true };
  } catch (err) {
    if (err instanceof ExpenseRequestError) return { error: err.code };
    // Deploy-morning rule (#472): this table is minted THIS release, and the
    // one machine where it may be missing is production mid-deploy.
    console.error('[rasxod]', err);
    return { error: 'failed' };
  }
}
