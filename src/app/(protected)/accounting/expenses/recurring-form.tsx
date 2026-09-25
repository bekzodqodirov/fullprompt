'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { saveRecurringAction, updateRecurringAction, type AccountingFormState } from '../actions';
import type { CategoryOption } from './expense-form';
import { RecurringError, type PayPartner, type PayTill } from './recurring-due';

interface Option {
  id: string;
  label: string;
}

/**
 * A fixed cost (rent, a salary) as a template — a promise with a day.
 *
 * Nothing posts (owner's Q6): each month appears on the due list, and
 * «To'landi» or «Bog'lash» writes it on the day the money actually left.
 * The kassa and the payer named here are only the DEFAULT a press offers.
 */
export function RecurringForm({
  categories,
  accounts,
  warehouses,
  employees,
  currencies,
  partners,
  today,
}: {
  categories: CategoryOption[];
  accounts: Option[];
  warehouses: Option[];
  employees: Option[];
  currencies: string[];
  partners: Option[];
  /** Tashkent's day, `YYYY-MM-DD` — the «Birinchi to'lov» default reads it. */
  today: string;
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
  // A non-cash kind names no kassa and no payer (U06) — the expense form's rule.
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const bookEntry = categories.find((option) => option.id === categoryId)?.cash === false;
  // «Birinchi to'lov» (G10): until the person touches it, it follows the
  // typed day — a payday already past this month starts next month, so a
  // template created on the 20th for the 5th does not arrive overdue.
  const [day, setDay] = useState('1');
  const [firstMonth, setFirstMonth] = useState<'this' | 'next' | null>(null);
  const suggested = Number(day) > 0 && Number(day) < Number(today.slice(8)) ? 'next' : 'this';
  const monthLabel = (offset: number) => {
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7)) + offset;
    const rolled = month > 12 ? { y: year + 1, m: month - 12 } : { y: year, m: month };
    return `${String(rolled.m).padStart(2, '0')}.${rolled.y}`;
  };

  return (
    <form action={formAction} className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <select
          name="categoryId"
          aria-label={t('category')}
          className="input min-w-40 flex-1"
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
          required
        >
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
            value={day}
            onChange={(event) => setDay(event.target.value)}
            aria-label={t('dayOfMonth')}
            className="input !w-20"
          />
        </label>
      </div>
      <label className="block text-sm">
        <span className="block text-xs text-ink-500">{t('recurringFirstMonth')}</span>
        {/* A select always posts its value and is never disabled (#171). */}
        <select
          name="firstMonth"
          data-testid="recurring-first-month"
          aria-label={t('recurringFirstMonth')}
          className="input"
          value={firstMonth ?? suggested}
          onChange={(event) => setFirstMonth(event.target.value === 'next' ? 'next' : 'this')}
        >
          <option value="this">{t('recurringFirstThis', { month: monthLabel(0) })}</option>
          <option value="next">{t('recurringFirstNext', { month: monthLabel(1) })}</option>
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        {!partnerId && !bookEntry && (
          <select name="accountId" aria-label={t('account')} className="input min-w-36 flex-1">
            <option value="">— {t('account')} —</option>
            {accounts.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        )}
        {partners.length > 0 && !bookEntry && (
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
      {bookEntry && <p className="text-xs text-ink-500">{t('nonCashHint')}</p>}
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
          {state.error === 'fx_missing'
            ? t('fxMissing')
            : state.error === 'account_currency_mismatch'
              ? t('accountCurrencyMismatch')
              : state.error === 'non_cash_category'
                ? t('nonCashCategory')
                : state.error === 'account_or_payer_required'
                  ? t('accountOrPayerRequired')
                  : state.error === 'amount_too_large'
                    ? tc('amountTooLarge')
                    : tc('error')}
        </p>
      )}
    </form>
  );
}

/**
 * A template's own row control (audit A32): its amount, its day, or stop it —
 * and, since the kassa and the payer are only a press's DEFAULTS (owner's
 * Q6), its currency and its usual payer (G1). WHAT the cost is stays fixed —
 * a different cost is a new template.
 *
 * Both selects ALWAYS carry the stored value, even a closed kassa or firm
 * marked «(yopilgan)», and default to it: an edit of the amount or a stop
 * re-posts them unchanged, and the service asks nothing about a payer nobody
 * touched. A select whose value is not among its options would fall back to
 * its first one and silently re-point the template.
 */
export function RecurringRowEdit({
  id,
  amount,
  dayOfMonth,
  active,
  cash,
  currency,
  currencies,
  stored,
  tills,
  partners,
}: {
  id: string;
  amount: string;
  dayOfMonth: number;
  active: boolean;
  /** False = a book entry: no payer at all (U06), so the row posts none. */
  cash: boolean;
  currency: string;
  currencies: string[];
  /** The template's own kassa or firm, open or closed. */
  stored: {
    accountId: string | null;
    accountName: string | null;
    accountCurrency: string | null;
    accountActive: boolean | null;
    partnerId: string | null;
    partnerName: string | null;
    partnerActive: boolean | null;
  };
  tills: PayTill[];
  partners: PayPartner[];
}) {
  const t = useTranslations('accounting');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<AccountingFormState, FormData>(
    updateRecurringAction,
    {},
  );
  const storedPayer = stored.partnerId
    ? `partner:${stored.partnerId}`
    : stored.accountId
      ? `till:${stored.accountId}`
      : '';
  const tillOptions = tills.some((row) => row.id === stored.accountId) || !stored.accountId
    ? tills
    : [
        {
          id: stored.accountId,
          name: `${stored.accountName ?? '—'} ${t('recurringClosedMark')}`,
          currency: stored.accountCurrency ?? currency,
        },
        ...tills,
      ];
  const partnerOptions = partners.some((row) => row.id === stored.partnerId) || !stored.partnerId
    ? partners
    : [{ id: stored.partnerId, name: `${stored.partnerName ?? '—'} ${t('recurringClosedMark')}` }, ...partners];
  const currencyOptions = currencies.includes(currency) ? currencies : [currency, ...currencies];
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
        <select
          name="currency"
          aria-label={t('currency')}
          defaultValue={currency}
          className="input !w-24"
          data-testid="recurring-edit-currency"
        >
          {currencyOptions.map((code) => (
            <option key={code}>{code}</option>
          ))}
        </select>
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
        {cash && (
          <label className="w-full text-xs">
            <span className="block text-ink-500">{t('recurringDefaultPayer')}</span>
            <select
              name="payer"
              aria-label={t('recurringDefaultPayer')}
              defaultValue={storedPayer}
              className="input"
              data-testid="recurring-edit-payer"
            >
              <option value="">{t('recurringNoPayer')}</option>
              {tillOptions.length > 0 && (
                <optgroup label={t('recurringTillGroup')}>
                  {tillOptions.map((row) => (
                    <option key={row.id} value={`till:${row.id}`}>
                      {row.name} ({row.currency})
                    </option>
                  ))}
                </optgroup>
              )}
              {partnerOptions.length > 0 && (
                <optgroup label={t('recurringPartnerGroup')}>
                  {partnerOptions.map((row) => (
                    <option key={row.id} value={`partner:${row.id}`}>
                      {row.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
        )}
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
        <RecurringError code={state.error} />
      </form>
    </details>
  );
}
