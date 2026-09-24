'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  generateRecurringAction,
  saveRecurringAction,
  updateRecurringAction,
  type AccountingFormState,
} from '../actions';

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
  partners,
}: {
  categories: Option[];
  accounts: Option[];
  warehouses: Option[];
  employees: Option[];
  currencies: string[];
  partners: Option[];
}) {
  const t = useTranslations('accounting');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<AccountingFormState, FormData>(
    saveRecurringAction,
    {},
  );
  // A rent paid through the transport company (audit A36): naming the firm
  // takes the till away, the expense form's own rule.
  const [partnerId, setPartnerId] = useState('');

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
          <span className="block text-xs text-ink-500">{t('dayOfMonth')}</span>
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
        {!partnerId && (
          <select name="accountId" aria-label={t('account')} className="input min-w-36 flex-1">
            <option value="">— {t('account')} —</option>
            {accounts.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        )}
        {partners.length > 0 && (
          <select
            name="partnerId"
            aria-label={t('paidBy')}
            data-testid="recurring-partner"
            className="input min-w-36 flex-1"
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
      {state.ok && <p className="text-sm font-semibold text-good">✅ {tc('saved')}</p>}
      {state.error && (
        <p className="text-sm font-semibold text-bad">
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
    AccountingFormState & { created?: number; skipped?: number; failed?: number },
    FormData
  >(async (_prev, formData) => generateRecurringAction(String(formData.get('month') ?? month)), {});

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <label className="text-sm">
        <span className="block text-xs text-ink-500">{t('period')}</span>
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
        <p className="w-full text-sm font-semibold text-good">
          ✅ {t('generated', { n: state.created ?? 0 })}
          {state.skipped ? ` · ${t('alreadyPosted', { n: state.skipped })}` : ''}
          {/* One template that could not post no longer takes the rest of the
              month with it — but it must be SAID, or the missing rent is
              found in the P&L months later. */}
          {state.failed ? (
            <span className="text-bad"> · {t('generateFailed', { n: state.failed })}</span>
          ) : null}
        </p>
      )}
      {state.error && (
        <p className="w-full text-sm font-semibold text-bad">
          {state.error === 'fx_missing' ? t('fxMissing') : tc('error')}
        </p>
      )}
    </form>
  );
}

/**
 * A template's own row control (audit A32): its amount, its day, or stop it.
 * The list was read-only and the only form could create, so a rent that
 * changed or a person who left went on posting every month. WHAT the cost is
 * stays fixed — a different cost is a new template.
 */
export function RecurringRowEdit({
  id,
  amount,
  dayOfMonth,
  active,
}: {
  id: string;
  amount: string;
  dayOfMonth: number;
  active: boolean;
}) {
  const t = useTranslations('accounting');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<AccountingFormState, FormData>(
    updateRecurringAction,
    {},
  );
  return (
    <details className="w-full" data-testid="recurring-edit">
      <summary className="cursor-pointer text-xs font-semibold text-brand-700">✏️ {t('recurringEdit')}</summary>
      <form action={formAction} className="mt-1 flex flex-wrap items-end gap-2">
        <input type="hidden" name="id" value={id} />
        <input
          name="amount"
          inputMode="decimal"
          defaultValue={Number(amount)}
          aria-label={t('amount')}
          className="input !w-32"
          data-testid="recurring-edit-amount"
          required
        />
        <label className="text-xs">
          <span className="block text-ink-500">{t('dayOfMonth')}</span>
          <input
            name="dayOfMonth"
            type="number"
            min={1}
            max={28}
            defaultValue={dayOfMonth}
            aria-label={t('dayOfMonth')}
            className="input !w-20"
            required
          />
        </label>
        {/* The hidden 'off' first: an unticked box posts nothing (#171). */}
        <input type="hidden" name="active" value="off" />
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" name="active" defaultChecked={active} data-testid="recurring-edit-active" />
          {t('recurringActive')}
        </label>
        <button type="submit" className="btn-secondary" disabled={pending} data-testid="recurring-edit-save">
          {pending ? tc('loading') : tc('save')}
        </button>
        {state.ok && <span className="text-sm font-semibold text-good">✅</span>}
        {state.error && <span className="text-sm font-semibold text-bad">{tc('error')}</span>}
      </form>
    </details>
  );
}
