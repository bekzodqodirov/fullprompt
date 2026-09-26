'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { voidTransactionAction } from '../actions';

/**
 * Void a wrongly-entered ledger row — reason is mandatory (audited). A
 * refusal is said in WORDS beside the ✖ (#420): the action used to swallow
 * it, and a refused void looked exactly like one that worked.
 */
export function VoidButton({ id, clientId, kind }: { id: string; clientId: string; kind?: string }) {
  const t = useTranslations('finance');
  const tc = useTranslations('common');
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-2">
      <button
        type="button"
        className="text-xs font-semibold text-bad underline"
        onClick={async () => {
          // A compensation's void is guarded (0105): say so before the prompt.
          const reason = window.prompt(
            kind === 'compensation' ? `${t('compensationVoidWarn')}\n\n${t('voidReason')}` : t('voidReason'),
          );
          if (!reason || reason.trim().length < 2) return;
          const fd = new FormData();
          fd.set('id', id);
          fd.set('clientId', clientId);
          fd.set('reason', reason.trim());
          setError(null);
          const res = await voidTransactionAction(fd);
          if (res.error) setError(voidErrorText(res.error, t, tc));
        }}
      >
        ✖ {t('void')}
      </button>
      {error && (
        <span role="alert" className="text-xs font-semibold text-bad">
          {error}
        </span>
      )}
    </span>
  );
}

/** The void's refusals in words — a literal map (#163). */
const VOID_ERRORS = {
  forbidden: 'voidNeedsAccountant',
  compensation_paid_out: 'compensationPaidOut',
} as const;

function voidErrorText(code: string, t: (key: string) => string, tc: (key: string) => string): string {
  const key = VOID_ERRORS[code as keyof typeof VOID_ERRORS];
  return key ? t(key) : tc('error');
}
