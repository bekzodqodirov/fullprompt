'use server';

import { revalidatePath } from 'next/cache';
import { requestMeta } from '@/modules/platform/auth/session';
import { isServerBehind } from '@/modules/platform/db/errors';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import {
  BorderQueueError,
  clearBorderWait,
  setBorderWait,
  type BorderQueueErrorCode,
} from '@/modules/wms/tracking/border-queue';

/** What the panel's form reads back: done, or a refusal it prints in words. */
export type BorderQueueFormState = { ok: true } | { error: BorderQueueErrorCode | 'server_behind' } | null;

const seenOf = (formData: FormData) => {
  const raw = String(formData.get('seenAt') ?? '');
  return raw === '' ? null : raw;
};

/**
 * The session half of the door; the service asks the permission again and
 * adds the scope clause a plain `authorize` cannot (`mayEditBorderQueue` — a
 * warehouse-scoped planner must not move every customer's date). A refusal
 * is a word on the panel, never a thrown page (#472): the one morning the
 * table may be missing is deploy morning.
 *
 * The typed number reaches /map, the dashboard, every truck card and the
 * customers' cabinets at once, so the whole app's cache goes, not one page.
 */
export async function saveBorderWaitAction(
  _prev: BorderQueueFormState,
  formData: FormData,
): Promise<BorderQueueFormState> {
  let actor;
  try {
    actor = await authorize('plans.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    await setBorderWait(
      actor,
      {
        post: String(formData.get('post') ?? ''),
        minDays: String(formData.get('minDays') ?? ''),
        maxDays: String(formData.get('maxDays') ?? ''),
        note: String(formData.get('note') ?? ''),
        seenAt: seenOf(formData),
      },
      meta,
    );
  } catch (err) {
    if (err instanceof BorderQueueError) return { error: err.code };
    if (isServerBehind(err)) return { error: 'server_behind' };
    throw err;
  }
  revalidatePath('/', 'layout');
  return { ok: true };
}

/** «Odatdagi jadvalga qaytarish» — the same door, the typed number gone. */
export async function resetBorderWaitAction(
  _prev: BorderQueueFormState,
  formData: FormData,
): Promise<BorderQueueFormState> {
  let actor;
  try {
    actor = await authorize('plans.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    await clearBorderWait(
      actor,
      { post: String(formData.get('post') ?? ''), seenAt: seenOf(formData) },
      meta,
    );
  } catch (err) {
    if (err instanceof BorderQueueError) return { error: err.code };
    if (isServerBehind(err)) return { error: 'server_behind' };
    throw err;
  }
  revalidatePath('/', 'layout');
  return { ok: true };
}
