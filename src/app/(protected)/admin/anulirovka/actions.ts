'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requestMeta } from '@/modules/platform/auth/session';
import { authorize } from '@/modules/platform/rbac/authorize';
import { AnnulError, annulReceipt, mayAnnul } from '@/modules/wms/receipts/annul';

const bulkSchema = z.object({
  receiptIds: z.array(z.string().uuid()).min(1).max(100),
  reason: z.string().trim().min(3).max(500),
});

export interface BulkAnnulState {
  done?: number;
  refused?: { id: string; code: string }[];
  error?: string;
}

/**
 * The cleanup loop: one atomic annul per receipt, a refusal never abandons
 * the rest (the bulk bar's rule), and the answer is COUNTS plus every
 * refusal named.
 */
export async function bulkAnnulAction(
  _prev: BulkAnnulState,
  formData: FormData,
): Promise<BulkAnnulState> {
  const parsed = bulkSchema.safeParse({
    receiptIds: formData.getAll('receiptIds'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) return { error: 'validation' };
  const actor = await authorize('receipts.void');
  if (!mayAnnul(actor)) return { error: 'annul_forbidden' };
  const meta = await requestMeta();

  let done = 0;
  const refused: { id: string; code: string }[] = [];
  for (const receiptId of parsed.data.receiptIds) {
    try {
      await annulReceipt(receiptId, parsed.data.reason, actor, { actorId: actor.id, ...meta });
      done += 1;
    } catch (err) {
      if (err instanceof AnnulError) refused.push({ id: receiptId, code: err.code });
      else throw err;
    }
  }
  revalidatePath('/admin/anulirovka');
  return { done, refused };
}
