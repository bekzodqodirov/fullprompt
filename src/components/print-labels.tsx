'use client';

import { useState } from 'react';
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

  async function share() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(href);
      if (!res.ok) throw new Error(String(res.status));
      const file = new File([await res.blob()], fileName, { type: 'application/pdf' });

      // canShare must be asked about THIS file: iOS answers false for files
      // on some versions, and a share() that throws leaves the operator with
      // a dead button and no explanation.
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: fileName });
        return;
      }

      // No file sharing: hand the PDF to the browser as a download. On
      // Android this is what RawBT intercepts; on a desktop it just opens.
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      // AbortError = the person closed the share sheet. That is not a failure
      // and must not paint the screen red.
      if ((err as Error)?.name !== 'AbortError') setError(tc('error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
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
        {t('openInBrowser')}
      </a>
      {error && (
        <p role="alert" className="text-center text-sm font-semibold text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
