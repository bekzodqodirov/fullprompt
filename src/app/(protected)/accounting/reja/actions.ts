'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { isAnalyst } from '@/modules/platform/ai/tools';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';
import { setTarget, TargetError } from '@/modules/wms/accounting/targets';

export interface TargetState {
  ok?: boolean;
  error?: string;
}

/** Empty = «no plan»; anything else must read as a number (#979's parser). */
function figure(raw: FormDataEntryValue | null): number | null | 'bad' {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  const value = parseTypedMoney(text);
  return value === null || !Number.isFinite(value) ? 'bad' : value;
}

/**
 * Save one month's plan (owner 5a). The plan is the owner's — his answer 4a
 * put the dashboard with him and the admin alone — so the door asks the
 * admin ROLE on top of the settings permission, the same pair the dashboard
 * is drawn behind. A refusal returns a code the form prints in words, and the
 * form keeps what was typed (#377/#463).
 */
export async function saveTargetAction(_prev: TargetState, form: FormData): Promise<TargetState> {
  let actor;
  try {
    actor = await authorize('admin.settings.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  if (!isAnalyst(actor)) return { error: 'forbidden' };
  const revenue = figure(form.get('revenueUsd'));
  const profit = figure(form.get('netProfitUsd'));
  if (revenue === 'bad' || profit === 'bad') return { error: 'bad_number' };
  try {
    await setTarget(
      { month: String(form.get('month') ?? ''), revenueUsd: revenue, netProfitUsd: profit },
      { actorId: actor.id, ...(await requestMeta()) },
    );
  } catch (err) {
    if (err instanceof TargetError) return { error: err.code };
    throw err;
  }
  revalidatePath('/accounting/reja');
  revalidatePath('/dashboard');
  revalidatePath('/');
  return { ok: true };
}
