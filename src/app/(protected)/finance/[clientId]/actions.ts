'use server';

import { revalidatePath } from 'next/cache';
import { getActor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';
import { cancelPromise, PromiseError, recordPromise } from '@/modules/wms/debt/promises';

/**
 * The payment promise's two doors (0114). Neither asks a permission here:
 * WHO may promise on this client's debt is `mayGrantDebt`, which depends on
 * whose client it is, so the service asks it with the actor (#531) — a check
 * only here would leave every other caller open, and a check here as well
 * would be a second copy of the rule to drift.
 */

export interface PromiseFormState {
  ok?: boolean;
  error?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function recordPromiseAction(_prev: PromiseFormState, form: FormData): Promise<PromiseFormState> {
  const actor = await getActor();
  if (!actor) return { error: 'forbidden' };
  const clientId = String(form.get('clientId') ?? '');
  if (!UUID.test(clientId)) return { error: 'validation' };
  // The office's way of typing a number («1 200», «1,5») — never NaN (#777).
  const amount = parseTypedMoney(String(form.get('amount') ?? ''));
  if (amount === null) return { error: 'bad_amount' };
  const meta = await requestMeta();
  try {
    await recordPromise(
      {
        clientId,
        amountUsd: amount,
        dueOn: String(form.get('dueOn') ?? ''),
        note: String(form.get('note') ?? ''),
      },
      { actorId: actor.id, ...meta },
      actor,
    );
  } catch (err) {
    if (err instanceof PromiseError) return { error: err.code };
    throw err;
  }
  revalidatePath(`/finance/${clientId}`);
  revalidatePath('/finance/qarzga-berilgan');
  return { ok: true };
}

export async function cancelPromiseAction(input: { promiseId: string; clientId: string }): Promise<PromiseFormState> {
  const actor = await getActor();
  if (!actor) return { error: 'forbidden' };
  if (!UUID.test(input.promiseId) || !UUID.test(input.clientId)) return { error: 'validation' };
  const meta = await requestMeta();
  try {
    await cancelPromise(input.promiseId, { actorId: actor.id, ...meta }, actor);
  } catch (err) {
    if (err instanceof PromiseError) return { error: err.code };
    throw err;
  }
  revalidatePath(`/finance/${input.clientId}`);
  revalidatePath('/finance/qarzga-berilgan');
  return { ok: true };
}
