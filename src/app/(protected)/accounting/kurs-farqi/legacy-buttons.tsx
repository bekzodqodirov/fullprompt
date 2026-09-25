'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { closeAllLegacyAction, closeLegacyAction, type FxLegacyResult } from './actions';

function useWords() {
  const t = useTranslations('accounting');
  const tc = useTranslations('common');
  // Literal map (#163).
  const words: Record<string, string> = {
    fx_legacy_changed: t('fxLegacyChanged'),
    fx_legacy_hand: t('fxLegacyHand'),
    fx_legacy_check: t('fxLegacyCheckFirst'),
  };
  return (code: string) => words[code] ?? tc('error');
}

/** One residue closed by hand — re-checked by the service under the account's lock. */
export function CloseLegacyButton(props: {
  ledger: 'client' | 'partner';
  ownerId: string;
  anchorId: string;
  currency: string;
}) {
  const t = useTranslations('accounting');
  const say = useWords();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FxLegacyResult | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <button
        type="button"
        className="btn-secondary !px-2 !py-0.5 text-xs"
        disabled={pending}
        data-testid="fx-legacy-close"
        onClick={() =>
          start(async () => {
            setResult(await closeLegacyAction(props));
          })
        }
      >
        ⚖️ {t('fxLegacyClose')}
      </button>
      {result?.error && <span className="text-xs font-semibold text-bad">{say(result.error)}</span>}
    </span>
  );
}

/** «Hammasini yopish» — `auto` + `closable` only; counted, never forced. */
export function CloseAllLegacyButton({ label }: { label: string }) {
  const t = useTranslations('accounting');
  const say = useWords();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FxLegacyResult | null>(null);
  return (
    <div className="space-y-1">
      <button
        type="button"
        className="btn-primary w-full"
        disabled={pending}
        data-testid="fx-legacy-close-all"
        onClick={() => {
          if (!window.confirm(label)) return;
          start(async () => {
            setResult(await closeAllLegacyAction());
          });
        }}
      >
        ⚖️ {label}
      </button>
      {result?.ok && (
        <p className="text-sm font-semibold text-good" data-testid="fx-legacy-done">
          {t('fxLegacyDone', { closed: result.closed ?? 0, changed: result.changed ?? 0 })}
        </p>
      )}
      {result?.error && <p className="text-sm font-semibold text-bad">{say(result.error)}</p>}
    </div>
  );
}
