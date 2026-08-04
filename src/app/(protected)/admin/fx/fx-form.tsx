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
      {/* "1 USD = N …" — the direction everyone quotes. The engine still
          stores rate_to_usd; the conversion happens in the action. */}
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-sm font-bold">1 USD =</span>
        <input
          name="unitsPerUsd"
          aria-label={t('rate')}
          className="input flex-1"
          inputMode="decimal"
          placeholder="12500"
          required
        />
        <select name="currency" aria-label="currency" className="input !w-28 shrink-0">
          {currencies
            .filter((c) => c !== 'USD')
            .map((c) => (
              <option key={c}>{c}</option>
            ))}
        </select>
      </div>
      <div className="flex gap-2">
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
