'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { chargeDealAction, type DealFormState } from './actions';

/**
 * Put this job's agreed price on the client's account.
 *
 * Raised from the DEAL rather than from the batch on purpose: only a charge
 * that carries its job can ever be covered by that job's payment deferral, so
 * "I'll pay when it is all here" reaches the handover gate instead of being a
 * note nobody acts on. A charge posted from batch pricing carries no deal and
 * keeps blocking exactly as it should — the deferral was granted for one job,
 * not for the client.
 *
 * Pre-filled with the quoted amount, which is right far more often than not,
 * and editable because the whole point of this feature is that the quote and
 * the final figure are allowed to differ.
 */
export function ChargeForm({
  dealId,
  clientId,
  suggested,
  currency,
}: {
  dealId: string;
  clientId: string;
  suggested: string | null;
  currency: string | null;
}) {
  const t = useTranslations('deals');
  const tc = useTranslations('common');
  const action = chargeDealAction.bind(null, dealId, clientId);
  const [state, formAction, pending] = useActionState<DealFormState, FormData>(action, {});

  return (
    <form action={formAction} className="space-y-2" data-testid="deal-charge-form">
      <div className="flex gap-2">
        <input
          name="amount"
          inputMode="decimal"
          defaultValue={suggested ?? ''}
          data-testid="charge-amount"
          aria-label={t('amount')}
          placeholder={t('amount')}
          className="input min-w-0 flex-1"
          required
        />
        <select
          name="currency"
          defaultValue={currency ?? 'USD'}
          aria-label={t('currency')}
          className="input !w-28"
        >
          <option value="USD">USD</option>
          <option value="CNY">CNY</option>
          <option value="UZS">UZS</option>
        </select>
      </div>
      <input name="note" placeholder={t('note')} aria-label={t('note')} className="input" />

      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {t(`errors.${state.error}` as 'errors.validation')}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        data-testid="save-charge"
        className="btn-primary w-full"
      >
        {pending ? tc('loading') : state.ok ? '✅' : t('postCharge')}
      </button>
    </form>
  );
}
