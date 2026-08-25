'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Scanner } from '@/components/scan/scanner';
import { armScanAudio, scanFeedback } from '@/components/scan/feedback';
import { binConfirmAction, binLookupAction, type BinCandidate } from './actions';

/**
 * «Musorga» — one crushed carton, scanned at the bin (owner, 2026-08-25:
 * «1 karobka musorga ketdi shikastlangan … scan qilib musorga tashlaydi izoh
 * yozib xabar logistga ketadi»).
 *
 * Two taps and a typed reason, in that order: the scan only LOOKS the carton
 * up and prints whose it is, because writing a box off is the one act on this
 * screen that no later scan can undo by itself — the way back is a manager on
 * the box card. The reason is mandatory and goes on the record, the seller
 * and the logist are both told, and the client's money is deliberately not
 * touched.
 */
export function BinBox({ warehouseId }: { warehouseId: string }) {
  const t = useTranslations('inventory');
  const tc = useTranslations('common');
  const [found, setFound] = useState<BinCandidate | null>(null);
  const [manual, setManual] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<'ok' | 'bad' | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => armScanAudio(), []);
  function feedback(kind: 'ok' | 'bad') {
    setFlash(kind);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 450);
    scanFeedback(kind);
  }

  async function lookup(raw: string) {
    const code = raw.trim().toUpperCase();
    if (code.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await binLookupAction({ warehouseId, code });
      if (res.ok && res.found) {
        setFound(res.found);
        feedback('ok');
      } else {
        setFound(null);
        setError(res.error ?? 'validation');
        feedback('bad');
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!found || busy || reason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      const res = await binConfirmAction({
        warehouseId,
        code: found.shortCode,
        boxId: found.boxId,
        reason,
      });
      if (res.ok) {
        setDone(res.shortCode ?? found.shortCode);
        setFound(null);
        setReason('');
        feedback('ok');
      } else {
        setError(res.error ?? 'validation');
        feedback('bad');
      }
    } finally {
      setBusy(false);
    }
  }

  const KNOWN = [
    'unknown_code',
    'box_elsewhere',
    'box_not_here',
    'box_issued',
    'box_void',
    'box_lost',
    'code_changed',
    'reason_required',
    'forbidden',
  ];

  return (
    <div
      className={`space-y-3 pb-8 transition-colors ${
        flash === 'ok' ? 'bg-good/15' : flash ? 'bg-bad/15' : ''
      }`}
    >
      <Scanner active={!found} onCode={(code) => void lookup(code)} />
      <div className="flex gap-2">
        <input
          data-testid="bin-code"
          className="input flex-1 font-mono uppercase"
          placeholder="YW26-000123"
          autoCapitalize="characters"
          value={manual}
          onChange={(e) => setManual(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              void lookup(manual);
              setManual('');
            }
          }}
        />
        <button
          type="button"
          className="btn-secondary px-4"
          onClick={() => {
            void lookup(manual);
            setManual('');
          }}
        >
          ✓
        </button>
      </div>

      {found && (
        <div className="card space-y-2 !p-3" data-testid="bin-pending">
          <p className="font-mono text-lg font-extrabold">
            {found.shortCode} · {found.clientCode ?? found.marking ?? '?'}
            {found.letter ? `-${found.letter}` : ''}
          </p>
          <p className="text-sm text-ink-700">{found.product}</p>
          <input
            data-testid="bin-reason"
            className="input"
            placeholder={t('binReason')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="text-2xs text-ink-500">{t('binMoneyNote')}</p>
          <button
            type="button"
            data-testid="bin-confirm"
            className="btn-danger w-full disabled:opacity-50"
            disabled={busy || reason.trim().length < 3}
            onClick={() => void confirm()}
          >
            {busy ? tc('loading') : `🗑 ${t('binBtn')}`}
          </button>
          <button
            type="button"
            className="btn-secondary w-full"
            onClick={() => {
              setFound(null);
              setReason('');
            }}
          >
            {tc('cancel')}
          </button>
        </div>
      )}

      {done && (
        <p className="rounded-lg bg-good/10 p-3 text-sm font-semibold text-good" data-testid="bin-done">
          ✅ {t('binDone', { code: done })}
        </p>
      )}

      {error && (
        <p role="alert" className="rounded-lg bg-bad/10 p-3 text-sm font-semibold text-bad" data-testid="bin-error">
          {KNOWN.includes(error) ? t(`binErrors.${error}` as 'binErrors.unknown_code') : error}
        </p>
      )}
    </div>
  );
}
