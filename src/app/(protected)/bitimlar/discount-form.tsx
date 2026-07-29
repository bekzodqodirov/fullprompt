'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { setDiscountAction, type DealFormState } from './actions';

/**
 * The damage discount (DEALS.md answer 3): the deal amount goes down, with a
 * reason that outlives the Telegram argument it settles. Amount 0 removes a
 * discount recorded by mistake — the audit log keeps both moves.
 *
 * Controlled inputs on purpose: React resets a form when its action returns,
 * and the commonest path here is "typed the amount, forgot the reason" — the
 * refusal must not also swallow the amount.
 */
export function DiscountForm({
  dealId,
  amount,
  reason,
}: {
  dealId: string;
  amount: string;
  reason: string | null;
}) {
  const t = useTranslations('deals');
  const tc = useTranslations('common');
  const action = setDiscountAction.bind(null, dealId);
  const [state, formAction, pending] = useActionState<DealFormState, FormData>(action, {});
  const [amountText, setAmountText] = useState(Number(amount) > 0 ? amount : '');
  const [reasonText, setReasonText] = useState(reason ?? '');

  return (
    <form action={formAction} className="space-y-2" data-testid="deal-discount-form">
      <p className="text-xs text-ink-500">{t('discountHint')}</p>
      <input
        name="amount"
        value={amountText}
        onChange={(e) => setAmountText(e.target.value)}
        inputMode="decimal"
        placeholder={t('discountAmount')}
        aria-label={t('discountAmount')}
        data-testid="discount-amount"
        className="input num"
      />
      <input
        name="reason"
        value={reasonText}
        onChange={(e) => setReasonText(e.target.value)}
        placeholder={t('discountReason')}
        aria-label={t('discountReason')}
        data-testid="discount-reason"
        className="input"
      />
      <button type="submit" disabled={pending} data-testid="save-discount" className="btn-primary w-full">
        {pending ? tc('loading') : state.ok ? '✅' : tc('save')}
      </button>
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {t(`errors.${state.error}` as 'errors.validation')}
        </p>
      )}
    </form>
  );
}
