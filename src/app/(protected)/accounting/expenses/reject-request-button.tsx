'use client';

import { useTranslations } from 'next-intl';
import { rejectExpenseRequestAction } from '../actions';

/**
 * «Rad etish» on a rasxod xabari (round 107) — a written reason, sent back
 * to the reporter's Telegram. The prompt is the void button's own idiom one
 * row over; a second decider racing this one gets `already_decided` from the
 * claim, never a second decision.
 */
export function RejectRequestButton({ id }: { id: string }) {
  const t = useTranslations('accounting');
  return (
    <button
      type="button"
      data-testid="reject-request"
      className="text-xs font-semibold text-bad underline"
      onClick={() => {
        const reason = window.prompt(t('rejectReason'));
        if (!reason || reason.trim().length < 2) return;
        void rejectExpenseRequestAction(id, reason.trim());
      }}
    >
      ⛔ {t('reject')}
    </button>
  );
}
