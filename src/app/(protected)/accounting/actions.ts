'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  AccountingError,
  accountSchema,
  addExpense,
  addTransfer,
  categorySchema,
  expenseSchema,
  needsKassaOrPayer,
  recurringPatchSchema,
  recurringSchema,
  saveAccount,
  saveCategory,
  saveRecurring,
  transferSchema,
  updateRecurring,
  voidExpense,
  voidTransfer,
} from '@/modules/wms/accounting/service';
import { checkbox } from '@/modules/platform/forms/checkbox';
import {
  claimExpenseRequest,
  ExpenseRequestError,
  expenseRequestReporter,
  finishExpenseRequest,
  rejectExpenseRequest,
  releaseExpenseRequest,
} from '@/modules/wms/accounting/expense-requests';
import { enqueue, JOB_PROCESS_EVENTS } from '@/modules/platform/jobs/boss';
import { openStaffPartner, StaffAccountError } from '@/modules/wms/partners/staff-account';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';
import { amountRefusal } from '@/modules/wms/finance/money-bounds';
import {
  linkRecurringPayment,
  payRecurring,
  payRecurringSchema,
  skipRecurring,
  unskipRecurring,
} from '@/modules/wms/accounting/recurring';

export interface AccountingFormState {
  ok?: boolean;
  error?: string;
  message?: string;
}

/**
 * A typed AMOUNT, read the office's way (U28): «1,200» is a thousand two
 * hundred — the old reader turned the comma into a decimal point and saved
 * $1.20 — and «12,500,000» is not NaN. The shared reader the calc screen and
 * the client ledger already use (#979); unreadable stays NaN, which z.number()
 * refuses, so the door answers «validation» instead of storing a guess.
 */
const money = (value: FormDataEntryValue | null) => parseTypedMoney(String(value ?? '')) ?? Number.NaN;

/**
 * A sort order or a day of the month — the old reader, kept for the fields
 * that are not money so the fix does not widen what they accept (zod's
 * `.int()` still refuses «5.5»).
 */
const int = (value: FormDataEntryValue | null) =>
  Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'));

/** The refusal of a zod parse in words: «too large» when it was the amount's size (U44). */
const refusal = (error: z.ZodError) => ({ error: amountRefusal(error) ?? 'validation' });


/** Everything here is owner/accountant territory (owner's answer 7). */
async function actor(permission: 'finance.expenses' | 'finance.reports') {
  return authorize(permission);
}

async function run<T>(
  permission: 'finance.expenses' | 'finance.reports',
  work: (ctx: { actorId: string } & Record<string, unknown>) => Promise<T>,
): Promise<AccountingFormState> {
  let who;
  try {
    who = await actor(permission);
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    await work({ actorId: who.id, ...meta });
    revalidatePath('/accounting', 'layout');
    return { ok: true };
  } catch (err) {
    if (err instanceof AccountingError || err instanceof ExpenseRequestError)
      return { error: err.code };
    throw err;
  }
}

export async function addExpenseAction(
  _prev: AccountingFormState,
  formData: FormData,
): Promise<AccountingFormState> {
  const parsed = expenseSchema.safeParse({
    categoryId: formData.get('categoryId'),
    amount: money(formData.get('amount')),
    currency: formData.get('currency'),
    expenseDate: formData.get('expenseDate'),
    warehouseId: String(formData.get('warehouseId') ?? ''),
    employeeId: String(formData.get('employeeId') ?? ''),
    accountId: String(formData.get('accountId') ?? ''),
    partnerId: String(formData.get('partnerId') ?? ''),
    note: String(formData.get('note') ?? ''),
  });
  if (!parsed.success) return refusal(parsed.error);
  // The rasxod xabari this expense answers, if any (round 107). The CLAIM
  // comes first — «one Kiritish wins» — and a refused expense releases it,
  // typed inputs and all. A crash between the claim and the save leaves a
  // visible done-with-nothing row on the panel rather than a silently
  // re-enterable one: the double-entry race is the common case.
  const rawRequest = String(formData.get('requestId') ?? '');
  const requestId = /^[0-9a-f-]{36}$/i.test(rawRequest) ? rawRequest : null;
  return run('finance.expenses', async (ctx) => {
    // A kassa or a payer is MANDATORY on a cash kind (U13, owner's A) — asked
    // before the rasxod xabari's claim, so a refusal leaves it open.
    if (await needsKassaOrPayer(parsed.data.categoryId, parsed.data)) {
      throw new AccountingError('account_or_payer_required');
    }
    if (!requestId) {
      await addExpense(parsed.data, ctx);
      return;
    }
    await claimExpenseRequest(requestId, ctx);
    let expenseId: string;
    try {
      expenseId = (await addExpense(parsed.data, ctx)).id;
    } catch (err) {
      await releaseExpenseRequest(requestId).catch(() => {});
      throw err;
    }
    await finishExpenseRequest(requestId, expenseId, ctx);
    await enqueue(JOB_PROCESS_EVENTS, {}).catch(() => {});
  });
}

/**
 * «Hodim kontragentini ochish» (owner M1a): an own-pocket report whose
 * reporter has no staff account yet. Gated like every other door on this
 * screen — `finance.expenses`, the accountant and the admin (M2a/M3a), never
 * `finance.manage`, which the VED holds. The login comes from the REQUEST
 * row, never from the post; the page then re-renders the same `?request=`
 * with the new account pre-selected as the payer.
 */
export async function openStaffPartnerAction(requestId: string): Promise<AccountingFormState> {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return { error: 'validation' };
  return run('finance.expenses', async (ctx) => {
    const request = await expenseRequestReporter(requestId);
    if (!request) throw new ExpenseRequestError('not_found');
    // Only a report that says «o'z pulimdan»: an account minted off a till-
    // paid report would invite the accountant to book a debt nobody is owed.
    if (!request.paidBySelf) throw new ExpenseRequestError('not_own_pocket');
    try {
      await openStaffPartner(request.createdBy, ctx);
    } catch (err) {
      if (err instanceof StaffAccountError) throw new ExpenseRequestError(err.code);
      throw err;
    }
  });
}

/** «Rad etish» on a rasxod xabari — a written reason, back to the reporter. */
export async function rejectExpenseRequestAction(
  id: string,
  reason: string,
): Promise<AccountingFormState> {
  const state = await run('finance.expenses', (ctx) => rejectExpenseRequest(id, reason, ctx));
  if (state.ok) await enqueue(JOB_PROCESS_EVENTS, {}).catch(() => {});
  return state;
}

export async function voidExpenseAction(id: string, reason: string): Promise<AccountingFormState> {
  return run('finance.expenses', (ctx) => voidExpense(id, reason, ctx));
}

export async function saveCategoryAction(
  _prev: AccountingFormState,
  formData: FormData,
): Promise<AccountingFormState> {
  const parsed = categorySchema.safeParse({
    name: formData.get('name'),
    cash: checkbox(formData, 'cash'),
    sortOrder: int(formData.get('sortOrder')) || 100,
    active: checkbox(formData, 'active'),
  });
  if (!parsed.success) return { error: 'validation' };
  const id = String(formData.get('id') ?? '') || undefined;
  return run('finance.expenses', (ctx) => saveCategory({ ...parsed.data, id }, ctx));
}

export async function saveAccountAction(
  _prev: AccountingFormState,
  formData: FormData,
): Promise<AccountingFormState> {
  // An EMPTY box is a real answer — nothing was in the till — but a typed
  // figure nobody can read is refused (U28). `|| 0` stored 0 over it, and on
  // an EDIT wiped an opening balance already on file (measured: 5000 → 0).
  const opening = String(formData.get('openingBalance') ?? '').trim();
  const parsed = accountSchema.safeParse({
    name: formData.get('name'),
    currency: formData.get('currency'),
    kind: formData.get('kind'),
    openingBalance: opening === '' ? 0 : (parseTypedMoney(opening) ?? Number.NaN),
    openingDate: String(formData.get('openingDate') ?? ''),
    sortOrder: int(formData.get('sortOrder')) || 100,
    active: checkbox(formData, 'active'),
  });
  if (!parsed.success) return refusal(parsed.error);
  const id = String(formData.get('id') ?? '') || undefined;
  return run('finance.expenses', (ctx) => saveAccount({ ...parsed.data, id }, ctx));
}

export async function saveRecurringAction(
  _prev: AccountingFormState,
  formData: FormData,
): Promise<AccountingFormState> {
  const parsed = recurringSchema.safeParse({
    categoryId: formData.get('categoryId'),
    amount: money(formData.get('amount')),
    currency: formData.get('currency'),
    dayOfMonth: int(formData.get('dayOfMonth')) || 1,
    warehouseId: String(formData.get('warehouseId') ?? ''),
    employeeId: String(formData.get('employeeId') ?? ''),
    accountId: String(formData.get('accountId') ?? ''),
    // Who pays it, when a firm does (audit A36) — the schema always took it
    // and the service dropped it.
    partnerId: String(formData.get('partnerId') ?? ''),
    note: String(formData.get('note') ?? ''),
    active: checkbox(formData, 'active'),
    // «Birinchi to'lov» (G10). A select always posts its value; anything but
    // 'next' is this month.
    firstMonth: String(formData.get('firstMonth') ?? 'this') === 'next' ? 'next' : 'this',
  });
  if (!parsed.success) return refusal(parsed.error);
  // CREATE only (M9): no `id` is read from the post. A template's own row
  // control is `updateRecurringAction`, which asks what an edit must.
  return run('finance.expenses', async (ctx) => {
    // Every payment of the template would be one-sided (U13, owner's A).
    if (await needsKassaOrPayer(parsed.data.categoryId, parsed.data)) {
      throw new AccountingError('account_or_payer_required');
    }
    await saveRecurring(parsed.data, ctx);
  });
}

/**
 * A template's amount, day, stop — and its currency and usual payer
 * (`updateRecurring`, audit A32 + Q6's G1). An absent field means «keep the
 * stored value»: a book entry's row posts no payer, and the row edit always
 * re-posts the stored ones even when their kassa has since been closed.
 */
export async function updateRecurringAction(
  _prev: AccountingFormState,
  formData: FormData,
): Promise<AccountingFormState> {
  const id = z.string().uuid().safeParse(formData.get('id'));
  const parsed = recurringPatchSchema.safeParse({
    amount: money(formData.get('amount')),
    dayOfMonth: int(formData.get('dayOfMonth')),
    // Paired with a hidden 'off' (#171): an unticked box posts nothing.
    active: checkbox(formData, 'active', false),
    currency: formData.has('currency') ? String(formData.get('currency')) : undefined,
    payer: formData.has('payer') ? String(formData.get('payer')) : undefined,
  });
  if (!id.success) return { error: 'validation' };
  if (!parsed.success) return refusal(parsed.error);
  const state = await run('finance.expenses', (ctx) => updateRecurring(id.data, parsed.data, ctx));
  if (state.ok) revalidateRecurring();
  return state;
}

// --- Recurring months: «To'landi», «Bog'lash», «Bu oy yo'q», «Qaytarish» ----
//
// Owner's Q6: money leaves a kassa only when the person responsible for it
// actually pays. `finance.expenses` is exactly the kassa holders
// (`mayPickTill`, M2a — the accountant and the admin; the VED holds
// `finance.manage` and not this), and the same permission sees staff
// counterparties (`maySeeStaffMoney`), so a salary paid on a colleague's
// behalf can be recorded by whoever opens these doors.

/** The screens that print the counter, beside the `/accounting` layout `run` already refreshes. */
function revalidateRecurring(firmMoved = false) {
  revalidatePath('/');
  revalidatePath('/dashboard');
  if (firmMoved) revalidatePath('/kontragentlar', 'layout');
}

export async function payRecurringAction(
  _prev: AccountingFormState,
  formData: FormData,
): Promise<AccountingFormState> {
  const payer = String(formData.get('payer') ?? '');
  const parsed = payRecurringSchema.safeParse({
    recurringId: formData.get('recurringId'),
    month: formData.get('month'),
    payer,
    amount: money(formData.get('amount')),
    currency: String(formData.get('currency') ?? ''),
    expenseDate: formData.get('expenseDate'),
    // Two NAMED submit buttons post 'on'/'off'; the single one posts nothing,
    // which means «the person did not say» and lets the amount decide (O3).
    partial: formData.has('partial') ? checkbox(formData, 'partial', false) : undefined,
    confirmNew: checkbox(formData, 'confirmNew', false),
    note: String(formData.get('note') ?? ''),
  });
  if (!parsed.success) return refusal(parsed.error);
  const state = await run('finance.expenses', (ctx) => payRecurring(parsed.data, ctx));
  if (state.ok) revalidateRecurring(payer.startsWith('partner:'));
  return state;
}

export async function linkRecurringAction(
  _prev: AccountingFormState,
  formData: FormData,
): Promise<AccountingFormState> {
  const parsed = z
    .object({ recurringId: z.string().uuid(), month: z.string(), expenseId: z.string().uuid() })
    .safeParse({
      recurringId: formData.get('recurringId'),
      month: formData.get('month'),
      expenseId: formData.get('expenseId'),
    });
  if (!parsed.success) return { error: 'validation' };
  const partial = formData.has('partial') ? checkbox(formData, 'partial', false) : undefined;
  const state = await run('finance.expenses', (ctx) =>
    linkRecurringPayment({ ...parsed.data, partial }, ctx),
  );
  if (state.ok) revalidateRecurring();
  return state;
}

export async function skipRecurringAction(
  _prev: AccountingFormState,
  formData: FormData,
): Promise<AccountingFormState> {
  const parsed = z
    .object({ recurringId: z.string().uuid(), month: z.string(), reason: z.string().max(2000) })
    .safeParse({
      recurringId: formData.get('recurringId'),
      month: formData.get('month'),
      reason: String(formData.get('reason') ?? ''),
    });
  if (!parsed.success) return { error: 'validation' };
  const state = await run('finance.expenses', (ctx) => skipRecurring(parsed.data, ctx));
  if (state.ok) revalidateRecurring();
  return state;
}

export async function unskipRecurringAction(
  _prev: AccountingFormState,
  formData: FormData,
): Promise<AccountingFormState> {
  const id = z.string().uuid().safeParse(formData.get('id'));
  if (!id.success) return { error: 'validation' };
  const state = await run('finance.expenses', (ctx) => unskipRecurring(id.data, ctx));
  if (state.ok) revalidateRecurring();
  return state;
}

export async function addTransferAction(
  _prev: AccountingFormState,
  formData: FormData,
): Promise<AccountingFormState> {
  const parsed = transferSchema.safeParse({
    fromAccountId: formData.get('fromAccountId'),
    toAccountId: formData.get('toAccountId'),
    amountFrom: money(formData.get('amountFrom')),
    amountTo: money(formData.get('amountTo')),
    transferDate: formData.get('transferDate'),
    note: String(formData.get('note') ?? ''),
  });
  if (!parsed.success) return refusal(parsed.error);
  return run('finance.expenses', (ctx) => addTransfer(parsed.data, ctx));
}

export async function voidTransferAction(id: string, reason: string): Promise<AccountingFormState> {
  return run('finance.expenses', (ctx) => voidTransfer(id, reason, ctx));
}
