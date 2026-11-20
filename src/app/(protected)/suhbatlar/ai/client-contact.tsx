'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { agentClientContactAction } from '@/modules/wms/agent/web-actions';
import { errorKey } from './labels';

/**
 * «AI raqamini ko'rsatish (sotuvchisi yo'q mijozlarga)» (stage 1a «Hajm», his 7 b) — the super_admin's tick: a client
 * chat no seller of ours answers is shown the AI's @handle in the bot's «💬 Menejer», the Mini App and the pushes'
 * manager door; a client WITH a seller never is. Its own section and its own action (§8: the AI page is shared by
 * four packages). Controlled, so a refusal keeps what he ticked (#463); the action revalidates the page (#1242).
 */
export function ClientContactToggle({ current }: { current: boolean }) {
  const t = useTranslations('agentAi');
  const [on, setOn] = useState(current);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const save = () =>
    start(async () => {
      const res = await agentClientContactAction(on);
      setError(res.ok ? null : t(errorKey(res.error) as 'errors.unknown'));
    });
  return (
    <div className="space-y-1" data-testid="agent-client-contact">
      <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
        <input
          type="checkbox"
          className="h-5 w-5 shrink-0"
          checked={on}
          disabled={pending}
          onChange={(event) => setOn(event.target.checked)}
          data-testid="agent-client-contact-box"
        />
        {t('clientContactLabel')}
      </label>
      <p className="text-xs text-ink-500">{t('clientContactHint')}</p>
      <button
        type="button"
        className="btn-secondary"
        disabled={pending || on === current}
        data-testid="agent-client-contact-save"
        onClick={save}
      >
        {t('save')}
      </button>
      {error && (
        <p className="text-sm font-semibold text-bad" role="alert" data-testid="agent-error">
          {error}
        </p>
      )}
    </div>
  );
}
