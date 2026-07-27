'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * Printing stickers from a phone.
 *
 * The owner installed the app to his home screen and the print button stopped
 * working — "iphoneda hech qanday buttonlarsiz stikerlar ro'yxati turibti".
 * That is not a bug in the button, it is what an installed PWA does on iOS:
 * the app runs with no browser chrome, so a PDF opened inside it renders in a
 * viewer that has NO share and NO print control. The stickers are right there
 * on the screen and there is no way to get them out.
 *
 * WHAT IS POSSIBLE, honestly:
 *  - iOS has no Web Bluetooth. Apple has never shipped it, so no web page on
 *    an iPhone can talk to a Bluetooth printer directly. Anyone who says
 *    otherwise is describing Android.
 *  - What iOS DOES have is the share sheet, and the share sheet is where
 *    AirPrint lives — and where a Bluetooth thermal printer's own app appears
 *    as a destination. `navigator.share` with a file opens it. That is the
 *    real route from this app to the printer in the warehouse, and it is one
 *    tap: Chop etish → Print / the printer's app.
 *  - Android keeps the direct link as well, because RawBT picks the PDF up
 *    and sends it to the paired printer without a share sheet at all.
 *
 * So this renders BOTH, and puts the one that works on the phone in hand
 * first. The fallback is "open in the browser", which on iOS breaks out of
 * the chromeless PWA into Safari, where the toolbar exists — the manual
 * escape hatch for the day a share sheet misbehaves in a cold warehouse.
 */
export function PrintLabels({
  href,
  label,
  fileName,
  variant = 'primary',
}: {
  /** The label PDF endpoint. */
  href: string;
  /** Button text — the caller already has the translation in context. */
  label: string;
  /** What the share sheet and the printer app will call it. */
  fileName: string;
  variant?: 'primary' | 'secondary';
}) {
  const t = useTranslations('receipts');
  const tc = useTranslations('common');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The PDF, fetched the moment the finger goes DOWN.
   *
   * Safari only allows `navigator.share()` while the tap is still "fresh" —
   * transient user activation. Fetching the file inside the click handler
   * spends that freshness waiting for the server (a hundred-box sheet is not
   * instant), and the share sheet then refuses to open with NotAllowedError:
   * the operator taps the button and nothing whatsoever happens, which is
   * exactly what it looked like. Starting on pointerdown means the file is
   * usually already in hand when the click arrives.
   */
  const pending = useRef<Promise<File> | null>(null);

  const load = useCallback(() => {
    pending.current ??= (async () => {
      const res = await fetch(href);
      if (!res.ok) throw new Error(String(res.status));
      return new File([await res.blob()], fileName, { type: 'application/pdf' });
    })();
    return pending.current;
  }, [href, fileName]);

  async function share() {
    setBusy(true);
    setError(null);
    try {
      const file = await load();

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: fileName });
        return;
      }
      throw new Error('cannot_share');
    } catch (err) {
      const name = (err as Error)?.name;
      // The person closed the sheet. Not a failure, and it must not paint the
      // screen red or bounce them into a PDF viewer they did not ask for.
      if (name === 'AbortError') return;

      /**
       * No share sheet on this phone, or the activation was spent anyway.
       * Open the PDF in a NEW TAB rather than "downloading" it: iOS ignores
       * the download attribute and renders the blob inline — inside the
       * installed app, which is the chromeless viewer with no buttons this
       * whole change exists to escape. A new tab at least lands somewhere
       * with a share control.
       */
      window.open(href, '_blank', 'noopener');
    } finally {
      setBusy(false);
      // A fresh sheet next time: the labels may have been reprinted since.
      pending.current = null;
    }
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        // Start fetching while the finger is still down — see `pending`.
        onPointerDown={() => void load().catch(() => {})}
        onClick={() => void share()}
        disabled={busy}
        data-testid="print-labels"
        className={`${variant === 'primary' ? 'btn-primary' : 'btn-secondary'} w-full`}
      >
        {busy ? tc('loading') : `🖨 ${label}`}
      </button>
      {/* Always present, never the main action: on iOS this is the way out of
          the chromeless app into Safari, where Share → Print exists. */}
      <a
        href={href}
        target="_blank"
        rel="noopener"
        data-testid="print-labels-browser"
        className="block text-center text-xs text-ink-500 underline"
      >
        {/* The per-lot buttons are a hundred pixels wide and the full
            sentence wrapped over four lines under each one. */}
        {variant === 'primary' ? t('openInBrowser') : t('openInBrowserShort')}
      </a>
      {error && (
        <p role="alert" className="text-center text-sm font-semibold text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
