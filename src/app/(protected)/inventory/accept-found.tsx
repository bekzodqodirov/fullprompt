'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Scanner } from '@/components/scan/scanner';
import { armScanAudio, scanFeedback } from '@/components/scan/feedback';
import { acceptFoundAction, type AcceptFoundResult } from './actions';

/**
 * «Bitta karobkani qabul qilish» (owner, 2026-08-25): the stocktake's
 * found-here rule for a single scan — a box standing on this floor while the
 * record says another warehouse or a truck. Scan it, read WHERE the record
 * had it, confirm; reality wins and the movement says so.
 *
 * Two taps on purpose: the scan only LOOKS the box up locally — nothing
 * moves until the operator has read «{code} — {reys}da deb yozilgan» and
 * pressed accept, because this button rewrites a record and a mis-scan of a
 * neighbouring carton must cost a glance, not a correction.
 */
export function AcceptFound({ warehouseId }: { warehouseId: string }) {
  const t = useTranslations('inventory');
  const tc = useTranslations('common');
  const [code, setCode] = useState('');
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AcceptFoundResult | null>(null);
  const [flash, setFlash] = useState<'ok' | 'bad' | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => armScanAudio(), []);
  function feedback(kind: 'ok' | 'bad') {
    setFlash(kind);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 450);
    scanFeedback(kind);
  }

  function onCode(raw: string) {
    const next = raw.trim().toUpperCase();
    if (next.length < 4 || busy) return;
    feedback('ok');
    setResult(null);
    setCode(next);
  }

  async function accept() {
    if (busy || !code) return;
    setBusy(true);
    try {
      const res = await acceptFoundAction({ warehouseId, code });
      setResult(res);
      feedback(res.ok ? 'ok' : 'bad');
      if (res.ok) setCode('');
    } finally {
      setBusy(false);
    }
  }

  const err = result && !result.ok ? (result.error ?? 'validation') : null;
  const KNOWN = [
    'unknown_code',
    'already_here',
    'still_loading',
    'box_issued',
    'box_void',
    'box_lost',
    'forbidden',
  ];

  return (
    <div
      className={`space-y-3 pb-8 transition-colors ${
        flash === 'ok' ? 'bg-good/15' : flash ? 'bg-bad/15' : ''
      }`}
    >
      <Scanner active={!code} onCode={onCode} />
      <div className="flex gap-2">
        <input
          data-testid="accept-code"
          className="input flex-1 font-mono uppercase"
          placeholder="YW26-000123"
          autoCapitalize="characters"
          value={manual}
          onChange={(e) => setManual(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onCode(manual);
              setManual('');
            }
          }}
        />
        <button
          type="button"
          className="btn-secondary px-4"
          onClick={() => {
            onCode(manual);
            setManual('');
          }}
        >
          ✓
        </button>
      </div>

      {code && (
        <div className="card space-y-2 !p-3 text-center" data-testid="accept-pending">
          <p className="font-mono text-xl font-extrabold">{code}</p>
          <p className="text-sm text-ink-700">{t('acceptConfirmHint')}</p>
          <button
            type="button"
            className="btn-primary w-full disabled:opacity-50"
            data-testid="accept-confirm"
            disabled={busy}
            onClick={() => void accept()}
          >
            {busy ? tc('loading') : `✅ ${t('acceptBtn')}`}
          </button>
          <button type="button" className="btn-secondary w-full" onClick={() => setCode('')}>
            {tc('cancel')}
          </button>
        </div>
      )}

      {result?.ok && result.found && (
        <div className="card space-y-1 !p-3" data-testid="accept-done">
          <p className="font-bold text-good">✅ {t('acceptDone')}</p>
          <p className="font-mono text-sm font-extrabold">
            {result.found.shortCode} · {result.found.clientCode ?? result.found.marking ?? '?'}
            {result.found.letter ? `-${result.found.letter}` : ''}
          </p>
          <p className="text-sm text-ink-700">{result.found.product}</p>
          <p className="text-xs text-ink-500">
            {result.found.fromBatchCode
              ? t('acceptFromTruck', { code: result.found.fromBatchCode })
              : t('acceptFromWh', { code: result.found.fromWhCode ?? '?' })}
          </p>
        </div>
      )}

      {err && (
        <p role="alert" className="rounded-lg bg-bad/10 p-3 text-sm font-semibold text-bad" data-testid="accept-error">
          {KNOWN.includes(err) ? t(`acceptErrors.${err}` as 'acceptErrors.unknown_code') : err}
        </p>
      )}
    </div>
  );
}
