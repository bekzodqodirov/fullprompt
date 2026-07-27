'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cancelPlanAction } from '../actions';

/**
 * Retire a plan nobody is going to finish.
 *
 * Offered only before approval — after that the plan owns a batch holding
 * real reserved boxes, and the way out is cancelling the BATCH, which gives
 * the cargo back. Two doors into the same room would be two chances to leave
 * boxes reserved against a plan that no longer exists.
 */
export function CancelPlan({ planId }: { planId: string }) {
  const t = useTranslations('plans');
  const tb = useTranslations('batches');
  const tc = useTranslations('common');
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setPending(true);
    setError(null);
    try {
      const res = await cancelPlanAction(planId, reason);
      if (res.ok) router.push('/plans');
      else setError(res.error ?? 'error');
    } finally {
      setPending(false);
    }
  }

  if (!asking) {
    return (
      <button
        type="button"
        data-testid="cancel-plan"
        className="text-sm text-ink-500 underline"
        onClick={() => setAsking(true)}
      >
        ✖ {t('cancelPlan')}
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-line p-2">
      <label className="label" htmlFor="cancel-plan-reason">
        {tb('cancelReason')}
      </label>
      <input
        id="cancel-plan-reason"
        className="input"
        value={reason}
        maxLength={200}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="cancel-plan-confirm"
          className="btn-danger flex-1 disabled:opacity-50"
          disabled={pending || reason.trim().length < 3}
          onClick={cancel}
        >
          {t('cancelPlan')}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setAsking(false)}>
          {tc('cancel')}
        </button>
      </div>
      {error && (
        <p className="rounded-lg bg-bad/10 p-2 text-sm font-semibold text-bad">
          {t(`errors.${error}` as never) || error}
        </p>
      )}
    </div>
  );
}
