'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { repriceStaleAction, type FxFormState } from './actions';
import { PreviewCard } from './preview-card';

/**
 * One stale (currency, month) line and its «Ko'rib chiqish» (§6.6): the first
 * press shows the plan, the second — carrying its hash — applies it. One
 * month of one currency, so the transaction's locks and the plan stay small.
 */
export function StaleReview({ currency, month, line }: { currency: string; month: string; line: string }) {
  const t = useTranslations('costing');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<FxFormState, FormData>(repriceStaleAction, {});
  const preview = state.error === 'confirm_reprice' && state.plan ? state : null;
  return (
    <form action={formAction} className="space-y-1 border-b border-line py-2 last:border-0" data-testid="fx-stale-row">
      <input type="hidden" name="currency" value={currency} />
      <input type="hidden" name="month" value={month} />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{line}</span>
        {!preview && (
          <button type="submit" className="btn-secondary !px-2 !py-1 text-xs" disabled={pending}>
            {pending ? '…' : t('fxStaleReview')}
          </button>
        )}
      </div>
      {preview?.plan && (
        <>
          <PreviewCard plan={preview.plan} changed={preview.changed} />
          <input type="hidden" name="planHash" value={preview.planHash ?? ''} />
          <button type="submit" className="btn-primary w-full" disabled={pending} data-testid="fx-stale-confirm">
            {pending ? '…' : t('fxPreviewConfirm')}
          </button>
        </>
      )}
      {state.ok && <p className="text-xs font-semibold text-good">✅ {t('fxRepriced', { count: state.repriced ?? 0 })}</p>}
      {state.error === 'busy' && <p className="text-xs font-semibold text-bad">{t('fxPreviewBusy')}</p>}
      {state.error && !['confirm_reprice', 'busy'].includes(state.error) && (
        <p className="text-xs font-semibold text-bad">{tc('error')}</p>
      )}
    </form>
  );
}
