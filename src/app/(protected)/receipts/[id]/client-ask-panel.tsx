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
    /**
     * A question that has not gone yet, judged by the PAGE's clock: `soon` =
     * due now; `later` = Telegram asked us to hold it (`waitAt` = when it will
     * go); `stuck` = it has been due for minutes and is still here (`waitAt` =
     * since when) — the sweep cannot send at all (no token, a refused token).
     */
    wait: 'soon' | 'later' | 'stuck';
    waitAt: string | null;
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

export function ClientAskPanel({
  receiptId,
  face,
  show,
}: {
  receiptId: string;
  face: ClientAskFace;
  /**
   * Whether the face has anything to draw. The block is MOUNTED either way
   * (the page mounts it wherever the client's side exists): «E'tirozlarni
   * yopish» on cargo that has left China empties the face, and a block that
   * unmounted with it took its own «✅ yopildi» away before anybody saw it.
   */
  show: boolean;
}) {
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
  // «Queued» is said by the status line once the action's own revalidation
  // has brought it — the two together said it twice.
  const said = done === 'closed' || (done === 'asked' && !status) ? done : null;
  if (!show && !said && !error) return null;

  return (
    <div className="card space-y-1.5 !p-3 text-sm" data-testid="client-ask">
      <p className="font-semibold text-ink-700">📨 {t('askTitle')}</p>
      {/* What WILL be sent — said only beside the button that sends it. */}
      {face.canAsk && (
        <p className="text-xs text-ink-500" data-testid="client-ask-hint">
          {t('askHint')}
        </p>
      )}

      {/* A wait is worded by how long it has lasted: «a minute or two» about
          a question the sweep cannot send at all (no bot token, a refused
          one) was read for hours with nothing to press. */}
      {status && waiting && status.wait === 'soon' && (
        <p className="text-xs text-ink-700" data-testid="client-ask-status" data-state={status.state} data-wait="soon">
          ⏳ {t('askWaiting')}
        </p>
      )}
      {status && waiting && status.wait === 'later' && (
        <p className="text-xs text-ink-700" data-testid="client-ask-status" data-state={status.state} data-wait="later">
          ⏳ {t('askLater', { when: status.waitAt ?? '—' })}
        </p>
      )}
      {status && waiting && status.wait === 'stuck' && (
        <p className="text-xs font-semibold text-warn [overflow-wrap:anywhere]" data-testid="client-ask-status" data-state={status.state} data-wait="stuck">
          ⚠️ {t('askStuck', { since: status.waitAt ?? '—' })}
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
          className="btn-secondary btn-sm w-full sm:w-auto"
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
          className="btn-secondary btn-sm w-full sm:w-auto"
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

      {said && (
        <p className="text-xs font-semibold text-good" role="status" data-testid="client-ask-done">
          {said === 'asked' ? t('askQueued') : t('disputeClosed')}
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
