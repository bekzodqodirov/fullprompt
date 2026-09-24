'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { mayPickTill } from '@/modules/wms/accounting/till-door';
import { MergeError, mergeDuplicate } from '@/modules/wms/accounting/cost-merge';
import { CostError, setCostStaffPayer } from '@/modules/wms/costing/service';

export interface QueueActionResult {
  ok: boolean;
  error?: string;
}

/**
 * The queue's doors (0101) all ask the kassa holders' grant, the same
 * `mayPickTill` the cost forms ask — a colleague's own-pocket money and a
 * merge that moves a kassa are both the accountant's decision (M1a, M2a).
 */
async function door() {
  const actor = await authorize('finance.expenses');
  if (!mayPickTill(actor.permissions)) throw new AuthError('till_forbidden', 'forbidden');
  return actor;
}

function done() {
  revalidatePath('/accounting/xarajat-kassa');
  revalidatePath('/accounting/accounts');
  revalidatePath('/accounting/expenses');
}

const staffSchema = z.object({ id: z.string().uuid(), partnerId: z.string().uuid() });

export async function setCostStaffAction(input: unknown): Promise<QueueActionResult> {
  const parsed = staffSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  let actor;
  try {
    actor = await door();
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  try {
    await setCostStaffPayer(parsed.data.id, parsed.data.partnerId, { actorId: actor.id, ...(await requestMeta()) });
  } catch (err) {
    if (err instanceof CostError) return { ok: false, error: err.code };
    throw err;
  }
  done();
  return { ok: true };
}

const mergeSchema = z.object({
  costIds: z.array(z.string().uuid()).min(1).max(50),
  expenseId: z.string().uuid(),
});

export async function mergeDuplicateAction(input: unknown): Promise<QueueActionResult> {
  const parsed = mergeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  let actor;
  try {
    actor = await door();
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  try {
    await mergeDuplicate(parsed.data, { actorId: actor.id, ...(await requestMeta()) });
  } catch (err) {
    if (err instanceof MergeError) return { ok: false, error: err.code };
    throw err;
  }
  done();
  return { ok: true };
}
