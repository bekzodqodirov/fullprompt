'use server';

import { revalidatePath } from 'next/cache';
import { getActor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { canWriteDeal } from '../deals/service';
import { CalcError, requestCalc } from './service';

export interface CalcFormState {
  ok?: boolean;
  error?: string;
}

/**
 * «Hisoblashga berish» — pressed on a deal or a lead card. Same gate as
 * working the deal itself: the people who ask for calculations are exactly
 * the people who work cards (sales, VED, client managers), and the service
 * separately refuses an assignee who is not VED.
 */
export async function requestCalcAction(
  entityType: 'deal' | 'lead',
  entityId: string,
  revalidate: string,
  _prev: CalcFormState,
  form: FormData,
): Promise<CalcFormState> {
  const actor = await getActor();
  if (!actor || !canWriteDeal(actor.permissions)) return { error: 'forbidden' };
  const assigneeId = String(form.get('assigneeId') ?? '');
  const itemCount = Number(form.get('itemCount'));
  if (!assigneeId || !Number.isFinite(itemCount)) return { error: 'validation' };
  const meta = await requestMeta();
  try {
    await requestCalc(
      { entityType, entityId, assigneeId, itemCount: Math.round(itemCount) },
      { actorId: actor.id, ...meta },
    );
  } catch (err) {
    if (err instanceof CalcError) return { error: err.code };
    throw err;
  }
  revalidatePath(revalidate);
  return { ok: true };
}
