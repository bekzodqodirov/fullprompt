'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Overlay } from '@/components/ui/overlay';

/** A lot on THIS screen whose factory barcode is the one just read. */
export interface IdentifiedLot {
  lotId: string;
  /** `GS777-A` — the code the pile is called by. */
  label: string;
  product: string;
  done: number;
  total: number;
}

interface ElsewhereHit {
  id: string;
  code: string;
  label?: string;
  href: string;
}

/**
 * «Which pile is this?» — the answer to a factory barcode read on a scan
 * screen (0112, the owner's Q10 c).
 *
 * A barcode names a PRODUCT, so it IDENTIFIES and never counts: nothing here
 * queues a scan, and the scanner underneath is paused while the sheet is open
 * (the screen passes `active={… && identify === null}`), or the next frame of
 * the same carton would reopen it. The lots come from the screen's own
 * snapshot; when none of them carries the code and the phone is online, the
 * global search is asked — it is scoped by the reader's own rule, so it can
 * only show what this person may already open.
 *
 * `countHref` is the slot the count packages fill: a door-holder's link to
 * the office count panel (`/batches/<id>#count-load` / `#count-accept`). The
 * hint says who counts stickerless cartons whether or not the link is there.
 *
 * Kept MOUNTED and toggled with `open`: an Overlay rendered already-open runs
 * its close-on-navigation effect on mount and shuts itself (#684).
 */
export function BarcodeIdentify({
  open,
  code,
  lots,
  countHref,
  onClose,
}: {
  open: boolean;
  code: string;
  lots: IdentifiedLot[];
  countHref?: string;
  onClose: () => void;
}) {
  const t = useTranslations('ofis');
  const [elsewhere, setElsewhere] = useState<ElsewhereHit[] | null>(null);
  const [offline, setOffline] = useState(false);
  // Answers arrive out of order on a slow link; only the latest may land.
  const asked = useRef(0);

  useEffect(() => {
    if (!open || lots.length > 0 || !code) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setElsewhere(null);
      setOffline(false);
      return;
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setOffline(true);
      return;
    }
    const mine = ++asked.current;
    void (async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(code)}`);
        if (!res.ok || mine !== asked.current) return;
        const { hits } = (await res.json()) as { hits: (ElsewhereHit & { kind: string })[] };
        setElsewhere(hits.filter((hit) => hit.kind === 'lot'));
      } catch {
        if (mine === asked.current) setOffline(true);
      }
    })();
  }, [open, code, lots.length]);

  return (
    <Overlay
      open={open}
      onClose={() => onClose()}
      closeLabel={t('close')}
      testId="barcode-identify"
      className="absolute inset-x-0 bottom-0 max-h-[75dvh] space-y-3 overflow-y-auto rounded-t-2xl bg-surface-raised p-4 pb-safe shadow-xl sm:inset-x-auto sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-96 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
    >
      <p className="break-all text-sm font-bold">{t('barcodeTitle', { code })}</p>
      {lots.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-ink-500">{t('barcodeHere')}</p>
          {lots.map((lot) => (
            <div
              key={lot.lotId}
              data-testid="barcode-identify-lot"
              className="flex items-center gap-2 rounded-lg border border-line p-2 text-sm"
            >
              <span className="shrink-0 font-mono font-extrabold text-brand-700">{lot.label}</span>
              <span className="min-w-0 flex-1 truncate text-ink-700">{lot.product}</span>
              <span className="shrink-0 font-semibold">
                {lot.done}/{lot.total}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1.5">
          <p className="text-sm text-ink-700">{t('barcodeNotHere')}</p>
          {offline && <p className="text-xs font-semibold text-warn">📴 {t('barcodeOffline')}</p>}
          {elsewhere && elsewhere.length > 0 && (
            <div data-testid="barcode-identify-elsewhere" className="space-y-1">
              <p className="text-xs font-semibold text-ink-500">{t('barcodeElsewhere')}</p>
              {elsewhere.map((hit) => (
                <Link
                  key={hit.id}
                  href={hit.href}
                  className="flex items-center gap-2 rounded-lg border border-line p-2 text-sm hover:bg-surface-sunken"
                >
                  <span className="shrink-0 font-mono font-extrabold text-brand-700">{hit.code}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-500">{hit.label}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-ink-500">{t('barcodeCountHint')}</p>
      {countHref && (
        <Link href={countHref} data-testid="barcode-identify-count" className="btn-secondary w-full">
          🔢 {t('barcodeCountLink')}
        </Link>
      )}
      <button
        type="button"
        data-testid="barcode-identify-close"
        className="btn-primary w-full"
        onClick={onClose}
      >
        {t('close')}
      </button>
    </Overlay>
  );
}
