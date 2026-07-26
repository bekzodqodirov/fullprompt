'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { saveFxRateAction, type FxFormState } from './actions';

/** Manual dated FX rate entry (spec: admin/accountant enters; USD is base). */
export function FxForm({ currencies, today }: { currencies: string[]; today: string }) {
  const t = useTranslations('costing');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<FxFormState, FormData>(saveFxRateAction, {});

  return (
    <form action={formAction} className="card space-y-2">
      <div className="flex gap-2">
        <select name="currency" aria-label="currency" className="input !w-28 shrink-0">
          {currencies
            .filter((c) => c !== 'USD')
            .map((c) => (
              <option key={c}>{c}</option>
            ))}
        </select>
        <input
          name="rateToUsd"
          aria-label={t('rate')}
          className="input flex-1"
          inputMode="decimal"
          placeholder={t('ratePlaceholder')}
          required
        />
        <input name="effectiveDate" aria-label={t('date')} type="date" className="input flex-1" defaultValue={today} required />
      </div>
      <p className="text-xs text-ink-500">{t('rateHint')}</p>
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {tc('error')}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn-primary w-full disabled:opacity-60">
        {pending ? '…' : state.ok ? `✅ ${tc('saved')}` : tc('save')}
      </button>
    </form>
  );
}
