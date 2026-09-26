'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { setPartnerTermsAction, type PartnerFormState } from '../actions';

/**
 * The firm's payment terms (0108): how many days a debt may wait, and how
 * much we let ourselves owe. Both optional; an empty box clears it. Folded,
 * because it is set once and read every day — the status line above the form
 * is what a person looks at.
 */
export function PartnerTermsForm({
  id,
  payWithinDays,
  debtLimitUsd,
}: {
  id: string;
  payWithinDays: number | null;
  debtLimitUsd: number | null;
}) {
  const t = useTranslations('partners');
  const tc = useTranslations('common');
  const [state, action, pending] = useActionState<PartnerFormState, FormData>(setPartnerTermsAction, {});
  return (
    <details className="card !p-3" data-testid="partner-terms-fold">
      <summary className="cursor-pointer text-sm font-semibold text-ink-700">⏰ {t('termsTitle')}</summary>
      <form action={action} className="mt-2 space-y-2">
        <input type="hidden" name="id" value={id} />
        <label className="block text-sm">
          <span className="label">{t('payWithinDays')}</span>
          <input
            name="payWithinDays"
            className="input"
            inputMode="numeric"
            defaultValue={payWithinDays ?? ''}
            placeholder="30"
            data-testid="partner-terms-days"
          />
        </label>
        <label className="block text-sm">
          <span className="label">{t('debtLimitUsd')}</span>
          <input
            name="debtLimitUsd"
            className="input"
            inputMode="decimal"
            defaultValue={debtLimitUsd ?? ''}
            placeholder="10 000"
            data-testid="partner-terms-limit"
          />
        </label>
        <p className="text-xs text-ink-500">{t('termsHint')}</p>
        <button type="submit" disabled={pending} className="btn-primary" data-testid="partner-terms-save">
          {pending ? '…' : state.ok ? `✅ ${tc('save')}` : tc('save')}
        </button>
        {state.error && (
          <p role="alert" className="text-sm font-semibold text-bad">
            {state.error === 'validation' ? t('termsInvalid') : tc('error')}
          </p>
        )}
      </form>
    </details>
  );
}
