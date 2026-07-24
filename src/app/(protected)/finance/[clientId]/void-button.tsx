'use client';

import { useTranslations } from 'next-intl';
import { voidTransactionAction } from '../actions';

/** Void a wrongly-entered ledger row — reason is mandatory (audited). */
export function VoidButton({ id, clientId }: { id: string; clientId: string }) {
  const t = useTranslations('finance');
  return (
    <button
      type="button"
      className="text-xs font-semibold text-red-700 underline"
      onClick={() => {
        const reason = window.prompt(t('voidReason'));
        if (!reason || reason.trim().length < 2) return;
        const fd = new FormData();
        fd.set('id', id);
        fd.set('clientId', clientId);
        fd.set('reason', reason.trim());
        void voidTransactionAction(fd);
      }}
    >
      ✖ {t('void')}
    </button>
  );
}
