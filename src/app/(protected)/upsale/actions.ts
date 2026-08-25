'use server';

import { revalidatePath } from 'next/cache';
import { getActor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { CalcError } from '@/modules/wms/calc/service';
import { releaseOffer } from '@/modules/wms/calc/workspace';
import { payUpsale, setUpsaleCategory } from '@/modules/wms/calc/upsale-service';
import { mayApproveBelowFloor, upsaleScopeFor } from '@/modules/wms/calc/upsale-scope';

export interface UpsaleFormState {
  ok?: boolean;
  error?: string;
  paidUsd?: number;
  count?: number;
}

/**
 * Paying a seller their share.
 *
 * Gated on `finance.expenses` AND the upsale scope: writing an expense is the
 * accountant's power, and seeing whose commission it is is law 4's. Neither
 * alone is the right door — the first would let anyone who may spend money
 * read every seller's earnings, the second would let the owner's read-only
 * analyst press pay.
 */
export async function payUpsaleAction(
  offerIds: string[],
  input: { accountId: string; currency: string; expenseDate: string; note?: string },
): Promise<UpsaleFormState> {
  const actor = await getActor();
  if (!actor) return { error: 'unauthenticated' };
  if (!actor.permissions.has('finance.expenses')) return { error: 'forbidden' };
  if (upsaleScopeFor(actor) !== 'all') return { error: 'forbidden' };

  const meta = await requestMeta();
  try {
    const res = await payUpsale(offerIds, input, { actorId: actor.id, ...meta });
    revalidatePath('/upsale');
    revalidatePath('/accounting/expenses');
    return { ok: true, paidUsd: res.paidUsd, count: res.count };
  } catch (err) {
    if (err instanceof CalcError) return { error: err.code };
    // 0088's columns. On deploy morning this screen must say a sentence.
    if (isServerBehind(err)) {
      logger.error({ err }, '[upsale] server behind — migration 0088 not applied');
      return { error: 'server_behind' };
    }
    throw err;
  }
}

/** Allowing a below-floor promise — law 4's «admin-only», at its one door. */
export async function releaseOfferAction(offerId: string): Promise<UpsaleFormState> {
  const actor = await getActor();
  if (!actor) return { error: 'unauthenticated' };
  if (!mayApproveBelowFloor(actor)) return { error: 'forbidden' };

  const meta = await requestMeta();
  try {
    await releaseOffer(offerId, { actorId: actor.id, ...meta });
    revalidatePath('/upsale');
    return { ok: true };
  } catch (err) {
    if (err instanceof CalcError) return { error: err.code };
    if (isServerBehind(err)) return { error: 'server_behind' };
    throw err;
  }
}

/**
 * Choosing the expense category a payout is written into.
 *
 * `admin.settings.manage` and NOT `finance.expenses`: it is a company-wide
 * setting, and the accountant who presses «to'lash» is not the person who
 * decides where the company's money is booked. The accountant still sees the
 * refusal in words, one line above the button, so a locked screen names its
 * own key rather than reading as broken.
 */
export async function setUpsaleCategoryAction(
  _prev: UpsaleFormState,
  formData: FormData,
): Promise<UpsaleFormState> {
  const actor = await getActor();
  if (!actor) return { error: 'unauthenticated' };
  if (!actor.permissions.has('admin.settings.manage')) return { error: 'forbidden' };

  const meta = await requestMeta();
  try {
    await setUpsaleCategory(String(formData.get('categoryId') ?? ''), {
      actorId: actor.id,
      ...meta,
    });
    revalidatePath('/upsale');
    return { ok: true };
  } catch (err) {
    if (err instanceof CalcError) return { error: err.code };
    if (isServerBehind(err)) return { error: 'server_behind' };
    throw err;
  }
}
