'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { generateRecurringAction, saveRecurringAction, type AccountingFormState } from '../actions';

interface Option {
  id: string;
  label: string;
}

/**
 * A fixed cost (rent, a salary) as a template.
 *
 * Nothing is posted automatically — the accountant presses "create this
 * month's fixed costs" and looks at what landed. A silent monthly insert
 * would quietly falsify the P&L of any month where the rent changed or
 * someone left.
 */
export function RecurringForm({
  categories,
  accounts,
  warehouses,
  employees,
  currencies,
}: {
  categories: Option[];
  accounts: Option[];
  warehouses: Option[];
  employees: Option[];
  currencies: string[];
}) {
  const t = useTranslations('accounting');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<AccountingFormState, FormData>(
    saveRecurringAction,
    {},
  );

  return (
    <form action={formAction} className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <select name="categoryId" aria-label={t('category')} className="input min-w-40 flex-1" required>
          {categories.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          name="amount"
          data-testid="recurring-amount"
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
        <label className="text-sm">
          <span className="block text-xs text-gray-500">{t('dayOfMonth')}</span>
          <input
            name="dayOfMonth"
            type="number"
            min={1}
            max={28}
            defaultValue={1}
            aria-label={t('dayOfMonth')}
            className="input !w-20"
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <select name="accountId" aria-label={t('account')} className="input min-w-36 flex-1">
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
        <select name="employeeId" aria-label={t('employee')} className="input min-w-36 flex-1">
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
        data-testid="save-recurring"
        className="btn-secondary w-full"
        disabled={pending}
      >
        {pending ? tc('loading') : tc('save')}
      </button>
      {state.ok && <p className="text-sm font-semibold text-green-700">✅ {tc('saved')}</p>}
      {state.error && (
        <p className="text-sm font-semibold text-red-700">
          {state.error === 'fx_missing' ? t('fxMissing') : tc('error')}
        </p>
      )}
    </form>
  );
}

/** Posts every active template into the chosen month, skipping what is there. */
export function GenerateRecurringButton({ month }: { month: string }) {
  const t = useTranslations('accounting');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<
    AccountingFormState & { created?: number; skipped?: number },
    FormData
  >(async (_prev, formData) => generateRecurringAction(String(formData.get('month') ?? month)), {});

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <label className="text-sm">
        <span className="block text-xs text-gray-500">{t('period')}</span>
        <input type="month" name="month" defaultValue={month} className="input !w-40" />
      </label>
      <button
        type="submit"
        data-testid="generate-recurring"
        className="btn-primary"
        disabled={pending}
      >
        {pending ? tc('loading') : `▶️ ${t('generateMonth')}`}
      </button>
      {state.ok && (
        <p className="w-full text-sm font-semibold text-green-700">
          ✅ {t('generated', { n: state.created ?? 0 })}
          {state.skipped ? ` · ${t('alreadyPosted', { n: state.skipped })}` : ''}
        </p>
      )}
      {state.error && (
        <p className="w-full text-sm font-semibold text-red-700">
          {state.error === 'fx_missing' ? t('fxMissing') : tc('error')}
        </p>
      )}
    </form>
  );
}
