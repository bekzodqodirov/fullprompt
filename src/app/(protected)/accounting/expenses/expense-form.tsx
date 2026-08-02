'use client';

import { useActionState, useState } from 'react';
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
  // `addExpense` drops the cash box whenever a payer is named — correctly, no
  // till of ours moved — but the form offered both at once and said nothing,
  // so the saved row meant something different from what was typed and only a
  // hand reconciliation of the till would ever show it. The picker now
  // disappears with the choice, the way the counterparty form already hides
  // its cash box for the kinds that move no money.
  const [partnerId, setPartnerId] = useState('');
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
        {/* Only while the money is ours. A hidden select posts nothing, so
            the service's own drop becomes unreachable rather than silent. */}
        {!partnerId && (
          <select name="accountId" aria-label={t('account')} className="input min-w-40 flex-1">
            <option value="">— {t('account')} —</option>
            {accounts.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        )}
        <select name="warehouseId" aria-label={t('warehouse')} className="input !w-32">
          <option value="">— {t('warehouse')} —</option>
          {warehouses.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {partners.length > 0 && (
          <select
            name="partnerId"
            aria-label={t('paidBy')}
            data-testid="expense-partner"
            className="input min-w-40 flex-1"
            value={partnerId}
            onChange={(event) => setPartnerId(event.target.value)}
          >
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
      {/* Already translated in all four bundles and never rendered until now:
          the rule was implied by a disappearing field instead of stated. */}
      {partnerId && <p className="text-xs text-ink-500">{t('paidByHint')}</p>}
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
