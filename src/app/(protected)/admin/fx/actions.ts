'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { enqueue, JOB_RECOMPUTE_COSTS } from '@/modules/platform/jobs/boss';
import { fxRateSchema, upsertFxRate } from '@/modules/wms/costing/service';

export interface FxFormState {
  ok?: boolean;
  error?: string;
}

export async function saveFxRateAction(
  _prev: FxFormState,
  formData: FormData,
): Promise<FxFormState> {
  const parsed = fxRateSchema.safeParse({
    currency: formData.get('currency'),
    rateToUsd: Number(String(formData.get('rateToUsd') ?? '').replace(',', '.')),
    effectiveDate: formData.get('effectiveDate'),
  });
  if (!parsed.success) return { error: 'validation' };
  if (parsed.data.currency === 'USD') return { error: 'usd_is_base' };

  let actor;
  try {
    actor = await authorize('costs.fx.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  await upsertFxRate(parsed.data, { actorId: actor.id, ...meta });
  // Rate edits move every allocation in that currency (spec 6.9).
  await enqueue(JOB_RECOMPUTE_COSTS, { currency: parsed.data.currency });
  revalidatePath('/admin/fx');
  return { ok: true };
}
