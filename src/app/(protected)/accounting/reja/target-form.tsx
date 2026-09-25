'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { saveTargetAction, type TargetState } from './actions';

/**
 * One month's plan: two figures, empty = «reja yo'q». CONTROLLED inputs, so a
 * refused save keeps what was typed (#377/#463 — a form that can be refused
 * must hold its inputs), and the refusal is printed in words from a literal
 * map (#163).
 */
export function TargetForm({
  month,
  revenueUsd,
  netProfitUsd,
}: {
  month: string;
  revenueUsd: number | null;
  netProfitUsd: number | null;
}) {
  const t = useTranslations('accounting');
  const [state, action, pending] = useActionState<TargetState, FormData>(saveTargetAction, {});
  const [revenue, setRevenue] = useState(revenueUsd === null ? '' : String(revenueUsd));
  const [profit, setProfit] = useState(netProfitUsd === null ? '' : String(netProfitUsd));

  // Literal calls, one per refusal, so the i18n tripwire can see each key (#163).
  const errors: Record<string, () => string> = {
    bad_number: () => t('rejaErr.bad_number'),
    negative: () => t('rejaErr.negative'),
    too_large: () => t('rejaErr.too_large'),
    bad_month: () => t('rejaErr.bad_month'),
    unauthenticated: () => t('rejaErr.unauthenticated'),
    forbidden: () => t('rejaErr.forbidden'),
  };
  const error = state.error ? (errors[state.error]?.() ?? state.error) : undefined;

  return (
    <form action={action} className="flex flex-wrap items-end gap-2" data-testid={`reja-form-${month}`}>
      <input type="hidden" name="month" value={month} />
      <label className="min-w-0 flex-1 basis-32 text-2xs text-ink-500">
        {t('rejaRevenue')}
        <input
          name="revenueUsd"
          inputMode="decimal"
          className="input mt-0.5 font-mono"
          value={revenue}
          onChange={(e) => setRevenue(e.target.value)}
          placeholder="—"
          data-testid="reja-revenue"
        />
      </label>
      <label className="min-w-0 flex-1 basis-32 text-2xs text-ink-500">
        {t('rejaProfit')}
        <input
          name="netProfitUsd"
          inputMode="decimal"
          className="input mt-0.5 font-mono"
          value={profit}
          onChange={(e) => setProfit(e.target.value)}
          placeholder="—"
          data-testid="reja-profit"
        />
      </label>
      <button type="submit" className="btn-secondary !min-h-11" disabled={pending} data-testid="reja-save">
        {t('rejaSave')}
      </button>
      {state.ok && <p className="basis-full text-xs font-semibold text-good">✓ {t('rejaSaved')}</p>}
      {state.error && (
        <p className="basis-full text-xs font-semibold text-bad" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

