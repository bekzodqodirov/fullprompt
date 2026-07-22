'use server';

import { authorize } from '@/modules/platform/rbac/authorize';
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
}

export async function submitReceiptAction(input: unknown): Promise<SubmitReceiptResult> {
  const parsed = confirmReceiptSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };

  const actor = await authorize('receipts.create', { warehouseId: parsed.data.warehouseId });
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
