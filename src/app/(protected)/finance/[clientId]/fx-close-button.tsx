'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { closeFxResidueAction, voidFxCloseAction } from '../actions';

/**
 * «Kurs farqi bilan yopish» (Q24 b) — drawn only when the service would take
 * it (`crossCloseOffer`), and it re-derives everything anyway. The refusal is
 * said in words; the confirm names the dollars, because the press writes the
 * P&L.
 */
export function FxCloseButton({ clientId, amountUsd }: { clientId: string; amountUsd: number }) {
  const t = useTranslations('finance');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const usd = `$${Math.abs(amountUsd).toFixed(2)}`;
  // Literal map (#163).
  const words: Record<string, string> = {
    fx_close_nothing: t('fxCloseNothing'),
    fx_close_single_currency: t('fxCloseSingleCurrency'),
    fx_close_too_large: t('fxCloseTooLarge'),
    fx_close_legacy_first: t('fxCloseLegacyFirst'),
  };
  return (
    <div className="card space-y-1 !p-3 text-sm" data-testid="fx-close">
      <p className="text-xs text-ink-700">{t('fxCloseHint', { usd })}</p>
      <button
        type="button"
        className="btn-secondary w-full"
        data-testid="fx-close-button"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(t('fxCloseHint', { usd }))) return;
          setError(null);
          start(async () => {
            const res = await closeFxResidueAction({ clientId });
            if (res.error) setError(res.error);
          });
        }}
      >
        ⚖️ {t('fxClose', { usd })}
      </button>
      {error && (
        <p className="text-sm font-semibold text-bad" data-testid="fx-close-error">
          {words[error] ?? t('fxCloseRefused')}
        </p>
      )}
    </div>
  );
}

/**
 * Undo a hand close — a reason is mandatory, like every void here. Its
 * refusal is SAID (review): a second tab's ✖ on an already-undone close, or a
 * grant taken away after the page rendered, used to press and do nothing.
 */
export function FxCloseUndo({ id, clientId }: { id: string; clientId: string }) {
  const t = useTranslations('finance');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        className="text-xs font-semibold text-bad underline"
        disabled={pending}
        data-testid="fx-close-undo"
        onClick={() => {
          const reason = window.prompt(t('voidReason'));
          if (!reason || reason.trim().length < 2) return;
          setError(null);
          start(async () => {
            const res = await voidFxCloseAction({ id, clientId, reason: reason.trim() });
            if (res.error) setError(res.error);
          });
        }}
      >
        ✖ {t('fxCloseUndo')}
      </button>
      {error && (
        <span className="text-xs font-semibold text-bad" data-testid="fx-close-undo-error">
          {error === 'already_voided' ? t('fxCloseUndoGone') : t('fxCloseUndoRefused')}
        </span>
      )}
    </span>
  );
}
