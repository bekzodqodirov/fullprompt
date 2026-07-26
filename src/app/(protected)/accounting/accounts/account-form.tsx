'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { saveAccountAction, type AccountingFormState } from '../actions';

export interface AccountRow {
  id: string;
  name: string;
  currency: string;
  kind: string;
  openingBalance: string;
  openingDate: string | null;
  sortOrder: number;
  active: boolean;
}

/**
 * A cash box or a bank account.
 *
 * The opening balance is what was in the box the day the system started
 * (owner: "ha kiritamiz") — without it every balance on screen would be wrong
 * by whatever was already there, and the first person to count the cash would
 * stop trusting the numbers.
 */
export function AccountForm({
  account,
  currencies,
}: {
  account?: AccountRow;
  currencies: string[];
}) {
  const t = useTranslations('accounting');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<AccountingFormState, FormData>(
    saveAccountAction,
    {},
  );
  const kinds = ['cash', 'bank', 'card'] as const;

  return (
    <form action={formAction} className={account ? 'space-y-2 border-t border-line pt-2' : 'card space-y-2'}>
      {!account && <h2 className="text-sm font-bold uppercase text-ink-500">🏦 {t('accounts')}</h2>}
      {account && <input type="hidden" name="id" value={account.id} />}
      <div className="flex flex-wrap gap-2">
        <input
          name="name"
          defaultValue={account?.name}
          placeholder={t('accountName')}
          aria-label={t('accountName')}
          className="input min-w-44 flex-1"
          data-testid="account-name"
          required
        />
        <select
          name="currency"
          defaultValue={account?.currency}
          aria-label={t('currency')}
          className="input !w-24"
        >
          {currencies.map((code) => (
            <option key={code}>{code}</option>
          ))}
        </select>
        <select
          name="kind"
          defaultValue={account?.kind ?? 'cash'}
          aria-label={t('kind')}
          className="input !w-32"
        >
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {t(kind)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        <label className="text-sm">
          <span className="block text-xs text-ink-500">{t('opening')}</span>
          <input
            name="openingBalance"
            inputMode="decimal"
            defaultValue={account ? Number(account.openingBalance) : 0}
            aria-label={t('opening')}
            className="input !w-32"
          />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-ink-500">{t('openingDate')}</span>
          <input
            type="date"
            name="openingDate"
            defaultValue={account?.openingDate ?? ''}
            aria-label={t('openingDate')}
            className="input !w-40"
          />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-ink-500">#</span>
          <input
            name="sortOrder"
            type="number"
            defaultValue={account?.sortOrder ?? 100}
            aria-label="#"
            className="input !w-20"
          />
        </label>
        <label className="flex items-center gap-1 self-end text-sm">
          {/* Paired with the checkbox: a browser sends nothing when unchecked. */}
          <input type="hidden" name="active" value="off" />
          <input
            type="checkbox"
            name="active"
            value="on"
            defaultChecked={account ? account.active : true}
            className="h-4 w-4"
          />
          {tc('active')}
        </label>
      </div>
      <button
        type="submit"
        data-testid={account ? 'update-account' : 'save-account'}
        className={account ? 'btn-secondary w-full' : 'btn-primary w-full'}
        disabled={pending}
      >
        {pending ? tc('loading') : tc('save')}
      </button>
      {state.ok && <p className="text-sm font-semibold text-good">✅ {tc('saved')}</p>}
      {state.error && <p className="text-sm font-semibold text-bad">{tc('error')}</p>}
    </form>
  );
}
