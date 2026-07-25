'use client';

import { useTranslations } from 'next-intl';
import { voidExpenseAction } from '../actions';

/** Expenses are never deleted — voided with a reason, exactly like the ledger. */
export function VoidExpenseButton({ id }: { id: string }) {
  const t = useTranslations('accounting');
  return (
    <button
      type="button"
      data-testid="void-expense"
      className="text-xs font-semibold text-red-700 underline"
      onClick={() => {
        const reason = window.prompt(t('voidReason'));
        if (!reason || reason.trim().length < 2) return;
        void voidExpenseAction(id, reason.trim());
      }}
    >
      ✖ {t('void')}
    </button>
  );
}
