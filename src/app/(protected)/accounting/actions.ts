'use server';

import { revalidatePath } from 'next/cache';
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
  recurringSchema,
  saveAccount,
  saveCategory,
  saveRecurring,
  transferSchema,
  voidExpense,
  voidTransfer,
} from '@/modules/wms/accounting/service';

export interface AccountingFormState {
  ok?: boolean;
  error?: string;
  message?: string;
}

const num = (value: FormDataEntryValue | null) =>
  Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'));

/**
 * Read a checkbox honestly.
 *
 * A browser sends nothing at all for an unchecked box, which is
 * indistinguishable from "the form has no such field". Every form here pairs
 * the checkbox with a hidden `off` before it, so the LAST value is the real
 * answer and a form that omits the field still gets the sensible default.
 */
const flag = (formData: FormData, name: string, fallback = true) => {
  const values = formData.getAll(name);
  return values.length === 0 ? fallback : values[values.length - 1] === 'on';
};

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
    if (err instanceof AccountingError) return { error: err.code };
    throw err;
  }
}

export async function addExpenseAction(
  _prev: AccountingFormState,
  formData: FormData,
): Promise<AccountingFormState> {
  const parsed = expenseSchema.safeParse({
    categoryId: formData.get('categoryId'),
    amount: num(formData.get('amount')),
    currency: formData.get('currency'),
    expenseDate: formData.get('expenseDate'),
    warehouseId: String(formData.get('warehouseId') ?? ''),
    employeeId: String(formData.get('employeeId') ?? ''),
    accountId: String(formData.get('accountId') ?? ''),
    note: String(formData.get('note') ?? ''),
  });
  if (!parsed.success) return { error: 'validation' };
  return run('finance.expenses', (ctx) => addExpense(parsed.data, ctx));
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
    cash: flag(formData, 'cash'),
    sortOrder: num(formData.get('sortOrder')) || 100,
    active: flag(formData, 'active'),
  });
  if (!parsed.success) return { error: 'validation' };
  const id = String(formData.get('id') ?? '') || undefined;
  return run('finance.expenses', (ctx) => saveCategory({ ...parsed.data, id }, ctx));
}

export async function saveAccountAction(
  _prev: AccountingFormState,
  formData: FormData,
): Promise<AccountingFormState> {
  const parsed = accountSchema.safeParse({
    name: formData.get('name'),
    currency: formData.get('currency'),
    kind: formData.get('kind'),
    openingBalance: num(formData.get('openingBalance')) || 0,
    openingDate: String(formData.get('openingDate') ?? ''),
    sortOrder: num(formData.get('sortOrder')) || 100,
    active: flag(formData, 'active'),
  });
  if (!parsed.success) return { error: 'validation' };
  const id = String(formData.get('id') ?? '') || undefined;
  return run('finance.expenses', (ctx) => saveAccount({ ...parsed.data, id }, ctx));
}

export async function saveRecurringAction(
  _prev: AccountingFormState,
  formData: FormData,
): Promise<AccountingFormState> {
  const parsed = recurringSchema.safeParse({
    categoryId: formData.get('categoryId'),
    amount: num(formData.get('amount')),
    currency: formData.get('currency'),
    dayOfMonth: num(formData.get('dayOfMonth')) || 1,
    warehouseId: String(formData.get('warehouseId') ?? ''),
    employeeId: String(formData.get('employeeId') ?? ''),
    accountId: String(formData.get('accountId') ?? ''),
    note: String(formData.get('note') ?? ''),
    active: flag(formData, 'active'),
  });
  if (!parsed.success) return { error: 'validation' };
  const id = String(formData.get('id') ?? '') || undefined;
  return run('finance.expenses', (ctx) => saveRecurring({ ...parsed.data, id }, ctx));
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
    amountFrom: num(formData.get('amountFrom')),
    amountTo: num(formData.get('amountTo')),
    transferDate: formData.get('transferDate'),
    note: String(formData.get('note') ?? ''),
  });
  if (!parsed.success) return { error: 'validation' };
  return run('finance.expenses', (ctx) => addTransfer(parsed.data, ctx));
}

export async function voidTransferAction(id: string, reason: string): Promise<AccountingFormState> {
  return run('finance.expenses', (ctx) => voidTransfer(id, reason, ctx));
}
