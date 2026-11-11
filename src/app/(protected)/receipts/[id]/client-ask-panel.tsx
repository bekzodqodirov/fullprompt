'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { askClientAction, dismissDisputesAction } from './client-ask-actions';

/**
 * «📨 Mijozdan so'rash» on the prixod card (0144, docs/TARKIB-TAKLIFLAR.md
 * §4.5) — ONE block for the prixod, because the question is one message
 * about every lot of it: the button, the fate of the last question in words
 * (never a Bot API sentence), and — when the client's one ❌ landed on
 * several lots — closing all of them in one press.
 *
 * Drawn only for whoever may tick (`mayCheckLot`, asked by the page and again
 * by the service, #531) and only where 0144 has landed. No `router.refresh()`
 * after an action that already revalidates (#1242).
 */

export interface ClientAskFace {
  /** A linked chat AND a lot still worth asking about (cargo in China). */
  canAsk: boolean;
  /** The client has no Telegram linked — said in words instead of a button. */
  noChat: boolean;
  status: {
    state: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
    /** When it went out, as the page's clock prints it. */
    when: string | null;
    by: string | null;
    failure: 'no_chat' | 'client_changed' | 'too_long' | 'receipt_changed' | 'blocked' | 'telegram' | null;
  } | null;
  /** This owner's ❌ rows on the prixod's lots, with the token each card line drew. */
  disputes: { lotId: string; token: string }[];
}

const KNOWN = [
  'forbidden',
  'receipt_not_confirmed',
  'no_client',
  'no_lots',
  'no_chat',
  'not_askable',
  'too_long',
  'already_queued',
  'too_soon',
  'check_changed',
  'busy',
  'server_behind',
] as const;
const errorKey = (code: string): (typeof KNOWN)[number] | 'other' =>
  (KNOWN as readonly string[]).includes(code) ? (code as (typeof KNOWN)[number]) : 'other';

export function ClientAskPanel({ receiptId, face }: { receiptId: string; face: ClientAskFace }) {
  const t = useTranslations('lotCheck');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<'asked' | 'closed' | null>(null);

  async function run(what: 'asked' | 'closed', call: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await call();
      if (res.ok) setDone(what);
      else setError(res.error);
    } catch {
      setError('network');
    } finally {
      setBusy(false);
    }
  }

  const status = face.status;
  const waiting = status?.state === 'pending' || status?.state === 'sending';

  return (
    <div className="mt-3 space-y-1.5 rounded-lg border border-line p-2 text-sm" data-testid="client-ask">
      <p className="font-semibold text-ink-700">📨 {t('askTitle')}</p>
      <p className="text-xs text-ink-500">{t('askHint')}</p>

      {status && waiting && (
        <p className="text-xs text-ink-700" data-testid="client-ask-status" data-state={status.state}>
          ⏳ {t('askWaiting')}
        </p>
      )}
      {status?.state === 'sent' && (
        <p className="text-xs text-ink-700 [overflow-wrap:anywhere]" data-testid="client-ask-status" data-state="sent">
          {t('askSent', { when: status.when ?? '—', by: status.by ?? '—' })}
        </p>
      )}
      {status && status.failure && (
        <p className="text-xs font-semibold text-warn [overflow-wrap:anywhere]" data-testid="client-ask-status" data-state={status.state}>
          ⚠️ {t(`askFailed.${status.failure}`)}
        </p>
      )}

      {face.noChat && (
        <p className="text-xs text-ink-500" data-testid="client-ask-nochat">
          {t('askNoChat')}
        </p>
      )}
      {face.canAsk && (
        <button
          type="button"
          className="btn-secondary w-full"
          data-testid="client-ask-send"
          disabled={busy || waiting}
          onClick={() => {
            if (!window.confirm(t('askConfirm'))) return;
            void run('asked', () => askClientAction(receiptId));
          }}
        >
          📨 {t('askSend')}
        </button>
      )}
      {face.disputes.length > 1 && (
        <button
          type="button"
          className="btn-secondary w-full"
          data-testid="client-dispute-close-all"
          disabled={busy}
          onClick={() => {
            if (!window.confirm(t('disputeCloseAllConfirm', { n: face.disputes.length }))) return;
            void run('closed', () => dismissDisputesAction({ receiptId, seen: face.disputes }));
          }}
        >
          {t('disputeCloseAll', { n: face.disputes.length })}
        </button>
      )}

      {done && (
        <p className="text-xs font-semibold text-good" role="status" data-testid="client-ask-done">
          {done === 'asked' ? t('askQueued') : t('disputeClosed')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs font-semibold text-bad" data-testid="client-ask-error">
          {t(`askErrors.${errorKey(error)}`)}
        </p>
      )}
    </div>
  );
}
