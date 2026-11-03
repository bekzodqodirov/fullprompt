'use client';

import { useState, useTransition } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cancelAgentReplyAction } from '@/modules/wms/agent/web-actions';

/**
 * «Bekor qilish» on an approved AI reply still waiting to leave — rendered
 * for its account holder only (the service asks again). A press that loses
 * the race with the listener (it has started the send) says so in words
 * instead of pretending; `onDone` lets the dock reload its own thread, the
 * pages are revalidated by the action itself (#1242: no refresh after an
 * action that already revalidates).
 *
 * `contents`: the button and the refusal are items of the ROW it sits in (the
 * bubble's header, the page's waiting card — both `flex-wrap`), and the
 * refusal takes a whole line of its own under them (`basis-full`). Beside the
 * button it squeezed «🤖 08:30 da ketadi» to a word per line at 360 px (final
 * review K34).
 */
export function AgentCancelButton({ outboxId, onDone }: { outboxId: string; onDone?: () => void }) {
  const t = useTranslations('crm');
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="contents">
      {error && (
        <span className="order-last basis-full text-right text-bad [overflow-wrap:anywhere]" data-testid="agent-cancel-error">
          {error}
        </span>
      )}
      <button
        type="button"
        disabled={pending}
        data-testid="agent-cancel"
        onClick={() =>
          start(async () => {
            const res = await cancelAgentReplyAction(outboxId, pathname);
            if (!res.ok) {
              setError(res.error === 'too_late' ? t('agentCancelTooLate') : t('agentCancelRefused'));
              return;
            }
            setError(null);
            onDone?.();
          })
        }
        className="btn-ghost !min-h-7 shrink-0 !px-2 text-xs"
      >
        {t('agentCancel')}
      </button>
    </span>
  );
}
