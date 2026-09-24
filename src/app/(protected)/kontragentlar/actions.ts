'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AuthError, authorize, type Actor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  PartnerError,
  addPartnerTx,
  partnerIdOfTx,
  partnerSchema,
  partnerTxSchema,
  savePartner,
  setPartnerActive,
  voidPartnerTx,
} from '@/modules/wms/partners/service';
import { recordSettlement, settlementSchema } from '@/modules/wms/partners/settlement';
import { isStaffPartner, isStaffType, maySeeStaffMoney } from '@/modules/wms/partners/staff';

/**
 * Every door into the partner ledger.
 *
 * Gated on `finance.manage` — the owner's answer 9, «buxgalter va admin».
 * Reading is `finance.view`, checked by the pages; writing money that changes
 * what we owe an outside firm is the accountant's, and no warehouse
 * permission reaches it.
 *
 * A STAFF account (0101) has a second, narrower door on top — owner M2a/M3a,
 * «faqat buxgalter va admin», i.e. `finance.expenses`: the VED holds
 * `finance.manage` and would otherwise hand a colleague a cash advance. So
 * `run` takes a REQUIRED `door` that every action has to answer — an optional
 * one fails open, and the five doors below are exactly the ones that touch
 * ONE account. The account is always resolved on the server from the posted
 * id (a void from the transaction ROW), never from anything else the form
 * says about it.
 */

export interface PartnerFormState {
  ok?: boolean;
  error?: string;
  /** The settlement form reports the rate gap the firm's own rate produced. */
  differenceUsd?: number;
}

/**
 * Refuses a non-`finance.expenses` actor on a staff account; null = allowed.
 * An id that names no account passes — the service then answers `not_found`.
 */
async function staffDoor(actor: Actor, partnerId: string | null): Promise<string | null> {
  if (!partnerId || maySeeStaffMoney(actor.permissions)) return null;
  return (await isStaffPartner(partnerId)) ? 'forbidden' : null;
}

/**
 * The partner form's door. Besides the account it edits, two things in the
 * POST can make an account staff or re-point it: the login and the «Hodim»
 * type. Setting or changing the login is the accountant's alone (the select
 * is drawn only for them, and a hand-made post is refused here, not merely
 * not drawn); a posted type of «Hodim» likewise — or a VED could open an
 * account that the list then hides from the person who opened it.
 */
async function partnerFormDoor(
  actor: Actor,
  id: string | null,
  typeId: string,
  userPosted: boolean,
): Promise<string | null> {
  if (maySeeStaffMoney(actor.permissions)) return null;
  if (userPosted) return 'forbidden';
  if (await isStaffType(typeId)) return 'forbidden';
  return staffDoor(actor, id);
}

async function run(
  door: (actor: Actor) => Promise<string | null>,
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
  const refused = await door(actor);
  if (refused) return { error: refused };
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
  // `has`, not `get() ?? ''`: a form that did not draw the login select must
  // leave the link alone, and '' would unlink it (partnerSchema's three states).
  const userPosted = formData.has('userId');
  const parsed = partnerSchema.safeParse({
    name: formData.get('name'),
    typeId: formData.get('typeId'),
    clientId: formData.get('clientId') ?? '',
    phone: formData.get('phone') ?? '',
    note: formData.get('note') ?? '',
    userId: userPosted ? String(formData.get('userId') ?? '') : undefined,
  });
  if (!parsed.success) return { error: 'validation' };
  if (id && !z.string().uuid().safeParse(id).success) return { error: 'validation' };
  return run(
    (actor) => partnerFormDoor(actor, id, parsed.data.typeId, userPosted),
    (ctx) => savePartner(id, parsed.data, ctx),
    ['/kontragentlar', id ? `/kontragentlar/${id}` : '/kontragentlar'],
  );
}

export async function setPartnerActiveAction(formData: FormData): Promise<void> {
  const id = z.string().uuid().safeParse(formData.get('id'));
  if (!id.success) return;
  await run(
    (actor) => staffDoor(actor, id.data),
    (ctx) => setPartnerActive(id.data, formData.get('active') === '1', ctx),
    ['/kontragentlar', `/kontragentlar/${id.data}`],
  );
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
  return run(
    (actor) => staffDoor(actor, parsed.data.partnerId),
    (ctx) => addPartnerTx(parsed.data, ctx),
    [`/kontragentlar/${partnerId}`, '/kontragentlar'],
  );
}

export async function voidPartnerTxAction(formData: FormData): Promise<void> {
  const id = z.string().uuid().safeParse(formData.get('id'));
  const partnerId = String(formData.get('partnerId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!id.success || reason.length < 3) return;
  await run(
    async (actor) => staffDoor(actor, await partnerIdOfTx(id.data)),
    (ctx) => voidPartnerTx(id.data, reason, ctx),
    [`/kontragentlar/${partnerId}`, '/kontragentlar', '/finance'],
  );
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
  const refused = await staffDoor(actor, parsed.data.partnerId);
  if (refused) return { error: refused };
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
