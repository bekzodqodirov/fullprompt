'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AuthError, authorize, type Actor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  CASH_TYPES,
  PartnerError,
  addPartnerTx,
  firmDebtVoidRefusal,
  partnerTxDoorFacts,
  partnerSchema,
  partnerTxSchema,
  savePartner,
  setAdjustKind,
  setPartnerActive,
  voidPartnerTx,
  ADJUST_KINDS,
} from '@/modules/wms/partners/service';
import { mayClassifyFx } from '@/modules/wms/finance/fx-door';
import { recordSettlement, settlementSchema } from '@/modules/wms/partners/settlement';
import { isStaffPartner, isStaffType, maySeeStaffMoney } from '@/modules/wms/partners/staff';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';
import { amountRefusal } from '@/modules/wms/finance/money-bounds';
import { mayPickTill } from '@/modules/wms/accounting/till-door';

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
 * The kassa half of a counterparty door (owner's answer b, 2026-09-25): money
 * that leaves a till for a firm, or enters one from it, and the void that puts
 * it back, are the accountant's and the admin's — `mayPickTill`, the kassa
 * screens' own grant, the same one every cost door asks. The VED keeps the
 * card and may still write a firm's DEBT (through a cost) and the «kurs farqi»
 * adjust; it never moves a till. Refused here, not only hidden (#531).
 */
function tillDoor(actor: Actor, movesTill: boolean): string | null {
  return movesTill && !mayPickTill(actor.permissions) ? 'till_forbidden' : null;
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
  work: (ctx: { actorId: string }, actor: Actor) => Promise<unknown>,
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
    await work({ actorId: actor.id, ...meta }, actor);
  } catch (err) {
    if (err instanceof PartnerError) return { error: err.code };
    throw err;
  }
  for (const path of paths) revalidatePath(path);
  return { ok: true };
}

/**
 * A typed amount, read the office's way (U28, #979's shared reader): «1,200»
 * is a thousand two hundred, not 1.2, and «1 200» is readable instead of a
 * refusal carrying zod's raw «Expected number, received nan». A leading «-»
 * still reads, for an `adjust`; anything unreadable stays NaN and is refused.
 */
const money = (value: FormDataEntryValue | null): number =>
  parseTypedMoney(String(value ?? '')) ?? Number.NaN;

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
    amount: money(formData.get('amount')),
    currency: formData.get('currency'),
    txDate: formData.get('txDate'),
    accountId: formData.get('accountId') ?? '',
    batchId: formData.get('batchId') ?? '',
    note: formData.get('note') ?? '',
    // What a correction IS (0103). Drawn only for whoever may classify; the
    // service refuses a posted kind from anybody else (`forbidden`).
    adjustKind: formData.get('adjustKind') || undefined,
  });
  // The two refines name the field ('amount' / 'account') and the form maps
  // them; a size refusal is its own sentence (U44). Any other issue is zod's
  // own English and never reaches the screen — it was, for an unreadable
  // amount, «Expected number, received nan».
  if (!parsed.success) {
    const size = amountRefusal(parsed.error);
    if (size) return { error: size };
    const named = parsed.error.issues.find(
      (issue) => issue.code === 'custom' && (issue.message === 'amount' || issue.message === 'account'),
    );
    return { error: named?.message ?? 'validation' };
  }
  return run(
    async (actor) =>
      tillDoor(actor, CASH_TYPES.includes(parsed.data.type)) ?? staffDoor(actor, parsed.data.partnerId),
    (ctx, actor) => addPartnerTx(parsed.data, ctx, { mayClassify: mayClassifyFx(actor.permissions) }),
    [`/kontragentlar/${partnerId}`, '/kontragentlar', '/accounting/kurs-farqi', '/accounting/pnl'],
  );
}

/**
 * «Ha, bu kurs farqi edi» / «Yo'q, boshqa tuzatish» on an old correction
 * (0103, Q12's split). `finance.manage` by `run`, then `finance.reports` —
 * the VED holds the first and must not write into the P&L (Q19) — and a
 * staff row's own door, judged on the ROW (`partnerTxDoorFacts`).
 */
export async function setAdjustKindAction(formData: FormData): Promise<PartnerFormState> {
  const id = z.string().uuid().safeParse(formData.get('id'));
  const kind = z.enum(ADJUST_KINDS).safeParse(formData.get('kind'));
  if (!id.success || !kind.success) return { error: 'validation' };
  const row = await partnerTxDoorFacts(id.data);
  return run(
    async (actor) => (mayClassifyFx(actor.permissions) ? staffDoor(actor, row?.partnerId ?? null) : 'forbidden'),
    (ctx, actor) =>
      setAdjustKind(id.data, kind.data, ctx, {
        mayClassify: mayClassifyFx(actor.permissions),
        maySeeStaff: maySeeStaffMoney(actor.permissions),
      }),
    ['/accounting/kurs-farqi', '/accounting/pnl', row ? `/kontragentlar/${row.partnerId}` : '/kontragentlar'],
  );
}

export async function voidPartnerTxAction(formData: FormData): Promise<void> {
  const id = z.string().uuid().safeParse(formData.get('id'));
  const partnerId = String(formData.get('partnerId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!id.success || reason.length < 3) return;
  await run(
    // Judged by the ROW: the kassa it moved, the account it sits on, and —
    // for a debt a cost or an expense wrote — the cost door's own rule.
    async (actor) => {
      const row = await partnerTxDoorFacts(id.data);
      return (
        tillDoor(actor, Boolean(row?.accountId)) ??
        (row ? await firmDebtVoidRefusal(actor, row) : null) ??
        staffDoor(actor, row?.partnerId ?? null)
      );
    },
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
    clientAmount: money(formData.get('clientAmount')),
    clientCurrency: formData.get('clientCurrency'),
    partnerAmount: money(formData.get('partnerAmount')),
    partnerCurrency: formData.get('partnerCurrency'),
    txDate: formData.get('txDate'),
    note: formData.get('note') ?? '',
    // Which job the client's money answers (U30) — the payment form's #531
    // wire, on the settlement door. The service checks it is this client's.
    dealId: formData.get('dealId') ?? '',
  });
  if (!parsed.success) return { error: amountRefusal(parsed.error) ?? 'validation' };

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
