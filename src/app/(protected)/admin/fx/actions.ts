'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { enqueue, JOB_RECOMPUTE_COSTS } from '@/modules/platform/jobs/boss';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { fxRates } from '@/modules/platform/db/schema';
import { fxRateSchema, upsertFxRate } from '@/modules/wms/costing/service';
import { isRateJump, perUsd, toRateToUsd } from '@/modules/wms/costing/fx-display';

export interface FxFormState {
  ok?: boolean;
  error?: string;
  /** On `rate_jump`: the standing rate, as «1 USD = N», for the question. */
  previous?: number;
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
  // A rate a fifth away from the currency's own last one is asked about, and
  // saved only once the person has said yes (audit A1). Asked here and not
  // only in the browser: the rate prices every new cost in its currency.
  const [standing] = await db
    .select({ rateToUsd: fxRates.rateToUsd })
    .from(fxRates)
    .where(eq(fxRates.currency, parsed.data.currency))
    .orderBy(desc(fxRates.effectiveDate))
    .limit(1);
  const previous = standing ? perUsd(Number(standing.rateToUsd)) : null;
  if (formData.get('confirmJump') !== '1' && isRateJump(previous, quoted)) {
    return { error: 'rate_jump', previous: previous ?? undefined };
  }

  await upsertFxRate(parsed.data, { actorId: actor.id, ...meta });
  // A rate converts the costs that were WAITING for it and nothing else: a
  // cost already converted keeps the rate of the day it was paid (owner, R1 —
  // this used to re-price every cost in the currency, spec 6.9's old rule).
  await enqueue(JOB_RECOMPUTE_COSTS, { currency: parsed.data.currency, unconverted: true });
  revalidatePath('/admin/fx');
  return { ok: true };
}
