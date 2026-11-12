'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { setLotQrSkippedAction } from './edit-actions';

/**
 * «QR yopishtirilmadi» after the receipt (0112, decision 32): a switch on the
 * lot card, never a field inside the lot form (a replace-all form re-posting
 * a checkbox is #171's trap).
 *
 * Marked → «remove the mark» (the stickers are on, scan them). Marked with
 * some cartons labelled since → also «mark again» (they fell off). Unmarked →
 * «mark». Each asks first in words, because each changes what the phones
 * expect and what a stocktake may write off. The server decides who may.
 */
export function QrSkipToggle({
  lotId,
  letter,
  marked,
  canRemark,
}: {
  lotId: string;
  letter: string;
  marked: boolean;
  /** Marked, and some live loose carton carries a sticker printed since. */
  canRemark: boolean;
}) {
  const t = useTranslations('qrsiz');
  const tc = useTranslations('common');
  const tb = useTranslations('countAccept');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function press(skipped: boolean) {
    const question = skipped ? t('markConfirm', { letter }) : t('unmarkConfirm', { letter });
    if (!window.confirm(question)) return;
    setError(null);
    start(async () => {
      const res = await setLotQrSkippedAction({ lotId, skipped });
      if (res.ok) return;
      setError(
        res.error === 'edit_window_closed'
          ? t('toggleWindow')
          : res.error === 'structural_locked'
            ? t('toggleLocked')
            : res.error === 'busy_retry'
              ? tb('errors.busy_retry')
              : tc('error'),
      );
    });
  }

  // A member of the lot's row of actions (docs/PRIXOD-KARTA.md §7.2): a
  // FRAGMENT, so each button is a flex item of that row beside its
  // neighbours, and the refusal takes a line of its own under the row
  // instead of breaking it in the middle.
  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() => press(!marked)}
        data-testid="lot-qr-toggle"
        className="btn-secondary btn-sm disabled:opacity-60"
      >
        {marked ? t('unmark') : t('mark')}
      </button>
      {marked && canRemark && (
        <button
          type="button"
          disabled={pending}
          onClick={() => press(true)}
          data-testid="lot-qr-remark"
          className="btn-secondary btn-sm disabled:opacity-60"
        >
          {t('remark')}
        </button>
      )}
      {error && (
        <p role="alert" data-testid="lot-qr-error" className="order-last basis-full text-sm font-semibold text-bad">
          {error}
        </p>
      )}
    </>
  );
}
