'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { clearPauseAction } from '@/modules/wms/agent/web-actions';

/**
 * «Tekshirdim, qayta yoqish» (review regression-11, his Q13 ⭐): a paused
 * Telegram account sends nothing — human replies included — until a person
 * who looked says so. Drawn for that account's manager and the super_admin
 * role; the service asks the same door again.
 */
export function ClearPauseButton({ accountId }: { accountId: string }) {
  const t = useTranslations('crm');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending}
        data-testid="pause-clear"
        onClick={() => {
          if (!window.confirm(t('pauseClearConfirm'))) return;
          start(async () => {
            const res = await clearPauseAction(accountId);
            setError(res.ok ? null : res.error === 'not_paused' ? t('pauseAlreadyCleared') : t('pauseClearRefused'));
          });
        }}
        className="btn-secondary !min-h-8 !py-1 text-xs"
      >
        {t('pauseClear')}
      </button>
      {error && (
        <span className="text-xs font-semibold" data-testid="pause-clear-error">
          {error}
        </span>
      )}
    </span>
  );
}
