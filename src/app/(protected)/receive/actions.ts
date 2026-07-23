'use server';

import { AuthError, authorize, type Actor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { enqueue, JOB_PROCESS_EVENTS } from '@/modules/platform/jobs/boss';
import {
  confirmReceipt,
  confirmReceiptSchema,
  ReceiptError,
} from '@/modules/wms/receipts/service';

export interface SubmitReceiptResult {
  ok: boolean;
  receiptId?: string;
  number?: string;
  lots?: { letter: string; productNameZh: string; boxCount: number }[];
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
