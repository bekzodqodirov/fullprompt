'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * «✅ Stikerlar yopishtirildi» under the QR-siz sheet (0112, decision 31).
 *
 * The ONE press that turns the printed cartons into cartons the phones scan.
 * It is deliberate and separate from printing: opening the sheet, the PDF or
 * the print dialog changes nothing, because a cancelled dialog must not make
 * 500 sacks «expect a scan» that nobody labelled. It posts the ids this sheet
 * RENDERED, and the server re-checks each one where it stamps (still here,
 * still QR-siz, allowed to this person) and answers how many landed.
 */
export function QrStuckConfirm({
  warehouseId,
  boxIds,
  backHref,
}: {
  warehouseId: string;
  boxIds: string[];
  backHref: string;
}) {
  const t = useTranslations('qrsiz');
  const tc = useTranslations('common');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ labelled: number; skipped: number } | null>(null);
  const [failed, setFailed] = useState(false);

  async function press() {
    if (!window.confirm(t('stuckConfirm', { n: boxIds.length }))) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch('/api/inventory/qrsiz-labels/stuck', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ warehouseId, boxIds }),
      });
      if (!res.ok) {
        setFailed(true);
        return;
      }
      setDone((await res.json()) as { labelled: number; skipped: number });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="no-print mb-3 space-y-1 rounded-lg bg-good/10 p-3 text-sm" data-testid="qr-stuck-done">
        <p className="font-semibold text-good">{t('stuckDone', { n: done.labelled })}</p>
        {done.skipped > 0 && <p className="text-ink-700">{t('stuckSkipped', { n: done.skipped })}</p>}
        <a href={backHref} className="block font-semibold text-brand-700 underline">
          ← {tc('back')}
        </a>
      </div>
    );
  }

  return (
    <div className="no-print mb-3 space-y-2 rounded-lg border border-line p-3">
      <p className="text-xs text-ink-700">{t('stuckHint')}</p>
      <button
        type="button"
        onClick={() => void press()}
        disabled={busy || boxIds.length === 0}
        data-testid="qr-stuck-confirm"
        className="btn-primary w-full disabled:opacity-60"
      >
        {busy ? tc('loading') : t('stuckBtn', { n: boxIds.length })}
      </button>
      {failed && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {t('stuckFailed')}
        </p>
      )}
    </div>
  );
}
