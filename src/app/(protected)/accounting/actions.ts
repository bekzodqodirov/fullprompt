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
  generateRecurring,
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
  });
  if (!parsed.success) return refusal(parsed.error);
  const id = String(formData.get('id') ?? '') || undefined;
  return run('finance.expenses', (ctx) => saveRecurring({ ...parsed.data, id }, ctx));
}

/** A template's amount, day or stop — `updateRecurring` (audit A32). */
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
  });
  if (!id.success) return { error: 'validation' };
  if (!parsed.success) return refusal(parsed.error);
  return run('finance.expenses', (ctx) => updateRecurring(id.data, parsed.data, ctx));
}

export async function generateRecurringAction(
  month: string,
): Promise<AccountingFormState & { created?: number; skipped?: number }> {
  let who;
  try {
    who = await actor('finance.expenses');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    const result = await generateRecurring(month, { actorId: who.id, ...meta });
    revalidatePath('/accounting', 'layout');
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof AccountingError) return { error: err.code };
    throw err;
  }
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
