'use server';

import { revalidatePath } from 'next/cache';
import { authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  ArrivalError,
  cancelExpectedArrival,
  createExpectedArrival,
  expectedArrivalSchema,
  markArrived,
} from '@/modules/wms/arrivals/service';

export interface ArrivalFormState {
  ok?: boolean;
  error?: string;
}

/**
 * Recording an expected arrival is a SALES act — the client tells their
 * manager, not the warehouse — so it is gated on `crm.leads`; a warehouse
 * manager who takes the call directly can write one too.
 */
async function actorForWrite() {
  try {
    return await authorize('crm.leads');
  } catch {
    return authorize('receipts.create');
  }
}

export async function createArrivalAction(
  _prev: ArrivalFormState,
  formData: FormData,
): Promise<ArrivalFormState> {
  const actor = await actorForWrite();
  const rawCount = String(formData.get('boxCount') ?? '').trim();
  const parsed = expectedArrivalSchema.safeParse({
    warehouseId: String(formData.get('warehouseId') ?? ''),
    clientId: String(formData.get('clientId') ?? ''),
    marking: String(formData.get('marking') ?? ''),
    boxCount: rawCount ? Number(rawCount) : undefined,
    expectedOn: String(formData.get('expectedOn') ?? ''),
    note: String(formData.get('note') ?? ''),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message === 'who_required' ? 'who_required' : 'validation' };
  }
  const meta = await requestMeta();
  try {
    await createExpectedArrival(parsed.data, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof ArrivalError) return { error: err.code };
    throw err;
  }
  revalidatePath('/arrivals');
  return { ok: true };
}

export async function cancelArrivalAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const reason = String(formData.get('reason') ?? '');
  const actor = await actorForWrite();
  const meta = await requestMeta();
  try {
    await cancelExpectedArrival(id, reason, { actorId: actor.id, ...meta });
  } catch (err) {
    if (!(err instanceof ArrivalError)) throw err;
  }
  revalidatePath('/arrivals');
}

export async function markArrivedAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const actor = await authorize('receipts.create');
  const meta = await requestMeta();
  try {
    await markArrived(id, { actorId: actor.id, ...meta });
  } catch (err) {
    if (!(err instanceof ArrivalError)) throw err;
  }
  revalidatePath('/arrivals');
}
