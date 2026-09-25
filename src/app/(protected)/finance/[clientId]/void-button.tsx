'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { voidTransactionAction } from '../actions';

/**
 * Void a wrongly-entered ledger row — reason is mandatory (audited). A
 * refusal is said in WORDS beside the ✖ (#420): the action used to swallow
 * it, and a refused void looked exactly like one that worked.
 */
export function VoidButton({ id, clientId }: { id: string; clientId: string }) {
  const t = useTranslations('finance');
  const tc = useTranslations('common');
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-2">
      <button
        type="button"
        className="text-xs font-semibold text-bad underline"
        onClick={async () => {
          const reason = window.prompt(t('voidReason'));
          if (!reason || reason.trim().length < 2) return;
          const fd = new FormData();
          fd.set('id', id);
          fd.set('clientId', clientId);
          fd.set('reason', reason.trim());
          setError(null);
          const res = await voidTransactionAction(fd);
          if (res.error) setError(res.error === 'forbidden' ? t('voidNeedsAccountant') : tc('error'));
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
