'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { deferPaymentAction, type DealFormState } from './actions';

/**
 * "I'll pay when it's all here."
 *
 * The deferral belongs to the DEAL rather than to the client: on a client it
 * becomes permanent, everybody forgets it, and that is how a debt gate quietly
 * stops working. It carries a reason, an author and an END — and the natural
 * end here resolves itself, because the system already knows how many boxes
 * belong to this job and how many have landed.
 *
 * The date is the fallback for the cases that are not about missing boxes.
 */
export function DeferForm({ dealId }: { dealId: string }) {
  const t = useTranslations('deals');
  const tc = useTranslations('common');
  const action = deferPaymentAction.bind(null, dealId);
  const [state, formAction, pending] = useActionState<DealFormState, FormData>(action, {});
  const [until, setUntil] = useState('all_arrived');

  return (
    <form action={formAction} className="space-y-2" data-testid="defer-form">
      <label className="block">
        <span className="label">{t('deferReason')}</span>
        <input name="reason" data-testid="defer-reason" required className="input" />
      </label>

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="until"
            value="all_arrived"
            checked={until === 'all_arrived'}
            onChange={() => setUntil('all_arrived')}
          />
          {t('deferUntilAll')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="until"
            value="date"
            checked={until === 'date'}
            onChange={() => setUntil('date')}
          />
          {t('deferUntilDate')}
        </label>
      </div>

      {until === 'date' && (
        <input type="date" name="untilDate" aria-label={t('deferUntilDate')} className="input" />
      )}

      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {t(`errors.${state.error}` as 'errors.validation')}
        </p>
      )}

      <button type="submit" disabled={pending} data-testid="save-defer" className="btn-primary w-full">
        {pending ? tc('loading') : state.ok ? '✅' : t('defer')}
      </button>
    </form>
  );
}
