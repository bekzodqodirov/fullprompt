'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { saveFxRateAction, type FxFormState } from './actions';

/**
 * Manual dated FX rate entry (spec: admin/accountant enters; USD is base).
 *
 * The currency starts EMPTY and must be chosen, and the standing rate is
 * printed beside the box (audit A1): the form used to open on CNY with the
 * so'm's «12500» as its placeholder, so the commonest typing stored CNY at
 * 1/12500. The inputs are controlled so a «are you sure?» answer keeps what
 * was typed (#463: a form that can be refused must hold its inputs).
 */
export function FxForm({
  currencies,
  today,
  standing,
}: {
  currencies: string[];
  today: string;
  /** Newest «1 USD = N» per currency, for the hint and the placeholder. */
  standing: Record<string, number>;
}) {
  const t = useTranslations('costing');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<FxFormState, FormData>(saveFxRateAction, {});
  const [currency, setCurrency] = useState('');
  const [units, setUnits] = useState('');
  const [date, setDate] = useState(today);
  const [confirmed, setConfirmed] = useState(false);
  const last = currency ? standing[currency] : undefined;

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
          placeholder={last !== undefined ? String(last) : ''}
          value={units}
          onChange={(event) => {
            setUnits(event.target.value);
            setConfirmed(false);
          }}
          required
        />
        <select
          name="currency"
          aria-label="currency"
          className="input !w-28 shrink-0"
          value={currency}
          onChange={(event) => {
            setCurrency(event.target.value);
            setConfirmed(false);
          }}
          required
          data-testid="fx-currency"
        >
          <option value="">—</option>
          {currencies
            .filter((c) => c !== 'USD')
            .map((c) => (
              <option key={c}>{c}</option>
            ))}
        </select>
      </div>
      {last !== undefined && (
        <p className="text-xs text-ink-700" data-testid="fx-standing">
          {t('rateStanding', { rate: last.toLocaleString('en-US'), currency })}
        </p>
      )}
      <div className="flex gap-2">
        <input
          name="effectiveDate"
          aria-label={t('date')}
          type="date"
          className="input flex-1"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          required
        />
      </div>
      <p className="text-xs text-ink-500">{t('rateHint')}</p>
      {state.error === 'rate_jump' && (
        <label className="flex items-start gap-2 rounded-lg bg-warn/10 p-2 text-sm font-semibold text-warn">
          <input
            type="checkbox"
            name="confirmJump"
            value="1"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            data-testid="fx-confirm-jump"
          />
          <span>{t('rateJump', { previous: (state.previous ?? 0).toLocaleString('en-US'), currency })}</span>
        </label>
      )}
      {state.error && state.error !== 'rate_jump' && (
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
