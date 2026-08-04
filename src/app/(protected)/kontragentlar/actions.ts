'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  PartnerError,
  addPartnerTx,
  partnerSchema,
  partnerTxSchema,
  savePartner,
  setPartnerActive,
  voidPartnerTx,
} from '@/modules/wms/partners/service';
import { recordSettlement, settlementSchema } from '@/modules/wms/partners/settlement';

/**
 * Every door into the partner ledger.
 *
 * Gated on `finance.manage` — the owner's answer 9, «buxgalter va admin».
 * Reading is `finance.view`, checked by the pages; writing money that changes
 * what we owe an outside firm is the accountant's, and no warehouse
 * permission reaches it.
 */

export interface PartnerFormState {
  ok?: boolean;
  error?: string;
  /** The settlement form reports the rate gap the firm's own rate produced. */
  differenceUsd?: number;
}

async function run(
  work: (ctx: { actorId: string }) => Promise<unknown>,
  paths: string[],
): Promise<PartnerFormState> {
  let actor;
  try {
    actor = await authorize('finance.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    await work({ actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof PartnerError) return { error: err.code };
    throw err;
  }
  for (const path of paths) revalidatePath(path);
  return { ok: true };
}

const num = (value: FormDataEntryValue | null): number => {
  const text = String(value ?? '').trim().replace(',', '.');
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : NaN;
};

export async function savePartnerAction(
  _prev: PartnerFormState,
  formData: FormData,
): Promise<PartnerFormState> {
  const id = String(formData.get('id') ?? '') || null;
  const parsed = partnerSchema.safeParse({
    name: formData.get('name'),
    typeId: formData.get('typeId'),
    clientId: formData.get('clientId') ?? '',
    phone: formData.get('phone') ?? '',
    note: formData.get('note') ?? '',
  });
  if (!parsed.success) return { error: 'validation' };
  return run((ctx) => savePartner(id, parsed.data, ctx), [
    '/kontragentlar',
    id ? `/kontragentlar/${id}` : '/kontragentlar',
  ]);
}

export async function setPartnerActiveAction(formData: FormData): Promise<void> {
  const id = z.string().uuid().safeParse(formData.get('id'));
  if (!id.success) return;
  await run((ctx) => setPartnerActive(id.data, formData.get('active') === '1', ctx), [
    '/kontragentlar',
    `/kontragentlar/${id.data}`,
  ]);
}

export async function addPartnerTxAction(
  _prev: PartnerFormState,
  formData: FormData,
): Promise<PartnerFormState> {
  const partnerId = String(formData.get('partnerId') ?? '');
  const parsed = partnerTxSchema.safeParse({
    partnerId,
    type: formData.get('type'),
    amount: num(formData.get('amount')),
    currency: formData.get('currency'),
    txDate: formData.get('txDate'),
    accountId: formData.get('accountId') ?? '',
    batchId: formData.get('batchId') ?? '',
    note: formData.get('note') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'validation' };
  return run((ctx) => addPartnerTx(parsed.data, ctx), [
    `/kontragentlar/${partnerId}`,
    '/kontragentlar',
  ]);
}

export async function voidPartnerTxAction(formData: FormData): Promise<void> {
  const id = z.string().uuid().safeParse(formData.get('id'));
  const partnerId = String(formData.get('partnerId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!id.success || reason.length < 3) return;
  await run((ctx) => voidPartnerTx(id.data, reason, ctx), [
    `/kontragentlar/${partnerId}`,
    '/kontragentlar',
    '/finance',
  ]);
}

/**
 * The three-cornered settlement. Returns the USD gap between what the client
 * sent and what the firm credited — the screen shows it rather than hiding
 * it, because that gap is exactly the thing worth arguing with the firm about.
 */
export async function recordSettlementAction(
  _prev: PartnerFormState,
  formData: FormData,
): Promise<PartnerFormState> {
  const parsed = settlementSchema.safeParse({
    txId: formData.get('txId'),
    clientId: formData.get('clientId'),
    partnerId: formData.get('partnerId'),
    clientAmount: num(formData.get('clientAmount')),
    clientCurrency: formData.get('clientCurrency'),
    partnerAmount: num(formData.get('partnerAmount')),
    partnerCurrency: formData.get('partnerCurrency'),
    txDate: formData.get('txDate'),
    note: formData.get('note') ?? '',
  });
  if (!parsed.success) return { error: 'validation' };

  let actor;
  try {
    actor = await authorize('finance.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    const result = await recordSettlement(parsed.data, { actorId: actor.id, ...meta });
    revalidatePath('/kontragentlar');
    revalidatePath(`/kontragentlar/${parsed.data.partnerId}`);
    revalidatePath(`/finance/${parsed.data.clientId}`);
    revalidatePath('/finance');
    return { ok: true, differenceUsd: result.differenceUsd };
  } catch (err) {
    if (err instanceof PartnerError) return { error: err.code };
    throw err;
  }
}
