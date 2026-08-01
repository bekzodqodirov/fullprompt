'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { addExpenseAction, type AccountingFormState } from '../actions';

interface Option {
  id: string;
  label: string;
}

/**
 * One expense. Warehouse and employee stay optional: rent belongs to a
 * warehouse, a salary to a person, and a bank fee to neither — forcing either
 * would make the operator invent an answer.
 */
export function ExpenseForm({
  categories,
  accounts,
  warehouses,
  employees,
  currencies,
  today,
  partners = [],
}: {
  categories: Option[];
  accounts: Option[];
  warehouses: Option[];
  employees: Option[];
  currencies: string[];
  today: string;
  /**
   * Counterparties who settle expenses on our behalf (round 39): the Chinese
   * warehouses are rented jointly with a transport company and the Chinese
   * staff are paid through it. Picking one means no cash box moves.
   */
  partners?: Option[];
}) {
  const t = useTranslations('accounting');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<AccountingFormState, FormData>(
    addExpenseAction,
    {},
  );

  return (
    <form action={formAction} className="card space-y-2">
      <h2 className="text-sm font-bold uppercase text-ink-500">🧾 {t('addExpense')}</h2>
      <div className="flex flex-wrap gap-2">
        <select name="categoryId" aria-label={t('category')} className="input min-w-44 flex-1" required>
          {categories.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          name="amount"
          data-testid="expense-amount"
          inputMode="decimal"
          placeholder={t('amount')}
          aria-label={t('amount')}
          className="input !w-32"
          required
        />
        <select name="currency" aria-label={t('currency')} className="input !w-24">
          {currencies.map((code) => (
            <option key={code}>{code}</option>
          ))}
        </select>
        <input
          type="date"
          name="expenseDate"
          aria-label={t('date')}
          defaultValue={today}
          className="input !w-40"
          required
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <select name="accountId" aria-label={t('account')} className="input min-w-40 flex-1">
          <option value="">— {t('account')} —</option>
          {accounts.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <select name="warehouseId" aria-label={t('warehouse')} className="input !w-32">
          <option value="">— {t('warehouse')} —</option>
          {warehouses.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {partners.length > 0 && (
          <select name="partnerId" aria-label={t('paidBy')} className="input min-w-40 flex-1">
            <option value="">— {t('paidByUs')} —</option>
            {partners.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        )}
        <select name="employeeId" aria-label={t('employee')} className="input min-w-40 flex-1">
          <option value="">— {t('employee')} —</option>
          {employees.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <input name="note" placeholder={t('note')} aria-label={t('note')} className="input" />
      <button
        type="submit"
        data-testid="save-expense"
        className="btn-primary w-full"
        disabled={pending}
      >
        {pending ? tc('loading') : t('save')}
      </button>
      {state.ok && <p className="text-sm font-semibold text-good">✅ {tc('saved')}</p>}
      {state.error && (
        <p className="text-sm font-semibold text-bad">
          {state.error === 'fx_missing' ? t('fxMissing') : tc('error')}
        </p>
      )}
    </form>
  );
}
