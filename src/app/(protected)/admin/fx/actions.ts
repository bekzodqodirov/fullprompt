'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { enqueue, JOB_RECOMPUTE_COSTS } from '@/modules/platform/jobs/boss';
import { fxRateSchema, upsertFxRate } from '@/modules/wms/costing/service';
import { toRateToUsd } from '@/modules/wms/costing/fx-display';

export interface FxFormState {
  ok?: boolean;
  error?: string;
}

export async function saveFxRateAction(
  _prev: FxFormState,
  formData: FormData,
): Promise<FxFormState> {
  // The form asks the question the way people say it — "1 USD = how many
  // so'm" — and this is where it becomes the rate_to_usd the engine stores.
  const quoted = Number(String(formData.get('unitsPerUsd') ?? '').replace(/\s/g, '').replace(',', '.'));
  const rateToUsd = toRateToUsd(quoted);
  if (rateToUsd === null) return { error: 'validation' };
  const parsed = fxRateSchema.safeParse({
    currency: formData.get('currency'),
    rateToUsd,
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
