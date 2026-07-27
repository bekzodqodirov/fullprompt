'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FIT_FLOOR_MM, FIT_STEP_MM, fitSize } from '@/modules/wms/labels/geometry';

/**
 * The label sheet's controls, and the print dialog itself.
 *
 * The owner's ask, in his words: "print buttoni bosganda stikerlar ochilyabti
 * — usha yerga print qilishni qoshsa boladimi, qaysi pagelarni qaysi printer
 * deb belgilaydigan oyna borku". He is describing the phone's own print
 * panel: choose the printer, choose the pages. A PDF cannot open it — a PDF
 * is a file, and inside an installed app it lands in a viewer with no
 * controls at all (#224). An HTML page CAN: `window.print()` is exactly that
 * dialog.
 *
 * So the sheet opens it by itself on arrival, and the button re-opens it for
 * the operator who dismissed it by accident.
 *
 * HONESTLY: `window.print()` inside a home-screen iOS app is reported to do
 * nothing on some iOS versions, and I could not find an Apple statement or a
 * WebKit bug to pin that down — it has to be tried on the actual phone. Which
 * is why the share sheet and the Safari escape hatch are on this screen too,
 * and not buried: if the dialog does not appear, the way out is visible in
 * the same place rather than a phone call away.
 */
export function PrintSheet({
  pdfHref,
  backHref,
  fileName,
  recordHref,
  count,
}: {
  /** The same labels as a PDF: the share sheet, AirPrint, RawBT. */
  pdfHref: string;
  backHref: string;
  fileName: string;
  /** POSTed when the operator actually asks to print. */
  recordHref: string;
  count: number;
}) {
  const t = useTranslations('receipts');
  const tc = useTranslations('common');
  const [sharing, setSharing] = useState(false);
  const printed = useRef(false);
  const shareFile = useRef<Promise<File> | null>(null);

  /**
   * "These stickers were printed."
   *
   * Sent when the dialog is OPENED, not when the page is opened. The PDF route
   * has always stamped every box the moment the file was generated, so merely
   * looking at a sheet counted as printing it; here there is at least a
   * deliberate act behind the record. `keepalive` because the print dialog
   * blocks the page and a plain fetch can be dropped underneath it.
   */
  const record = useCallback(() => {
    try {
      void fetch(recordHref, { method: 'POST', keepalive: true }).catch(() => {});
    } catch {
      /* the sticker matters more than the log line */
    }
  }, [recordHref]);

  const print = useCallback(() => {
    record();
    window.print();
  }, [record]);

  useEffect(() => {
    // Shrink-to-fit runs before anything is painted to paper: the client code
    // is the dominant element and a long one would otherwise run off the
    // sticker. Same rule as the PDF, measured the browser's way.
    fitLabels(document);
    if (printed.current) return;
    printed.current = true;
    // One frame, so the fitted text is laid out before the dialog snapshots
    // the page. Without it Chrome can capture the pre-fit sizes.
    const raf = requestAnimationFrame(() => {
      record();
      window.print();
    });
    return () => cancelAnimationFrame(raf);
  }, [record]);

  async function share() {
    setSharing(true);
    try {
      shareFile.current ??= (async () => {
        const res = await fetch(pdfHref);
        if (!res.ok) throw new Error(String(res.status));
        return new File([await res.blob()], fileName, { type: 'application/pdf' });
      })();
      const file = await shareFile.current;
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: fileName });
        return;
      }
      throw new Error('cannot_share');
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      window.open(pdfHref, '_blank', 'noopener');
    } finally {
      setSharing(false);
      shareFile.current = null;
    }
  }

  return (
    <div className="no-print sticky top-0 z-10 mb-3 space-y-2 border-b border-zinc-200 bg-white p-3">
      <div className="flex items-center gap-2">
        <a href={backHref} className="btn-ghost !min-h-9 shrink-0 px-2 text-sm font-semibold">
          ←
        </a>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-700">
          {fileName} · {count} 🏷
        </span>
      </div>
      <button
        type="button"
        onClick={print}
        data-testid="print-now"
        className="btn-primary w-full"
      >
        🖨 {t('printDialog')}
      </button>
      {/* Not a fallback tucked under a link: on an iPhone this may be the one
          that works, and the operator must not have to be told which. */}
      <button
        type="button"
        onClick={() => void share()}
        disabled={sharing}
        data-testid="print-share"
        className="btn-secondary w-full"
      >
        {sharing ? tc('loading') : `📤 ${t('shareToPrinter')}`}
      </button>
      <a
        href={pdfHref}
        target="_blank"
        rel="noopener"
        data-testid="print-pdf"
        className="block text-center text-xs text-zinc-500 underline"
      >
        {t('openInBrowser')}
      </a>
    </div>
  );
}

/**
 * The PDF's `fitSize`, measured the browser's way.
 *
 * `getComputedTextLength()` is the SVG equivalent of pdf-lib's
 * `widthOfTextAtSize`, and because the sheet's viewBox maps one user unit to
 * one millimetre, it returns millimetres — the same units the geometry is
 * written in. The stepping and the floor come from the shared function, so
 * the two renderers cannot disagree about when a code is too long.
 *
 * Exported for the test: a fitter that silently does nothing looks exactly
 * like a fitter that had nothing to do.
 */
export function fitLabels(root: Document | HTMLElement): number {
  let shrunk = 0;
  const nodes = root.querySelectorAll<SVGTextElement>('text[data-fit]');
  for (const node of nodes) {
    const maxWidth = Number(node.dataset.fit);
    const start = Number(node.getAttribute('font-size'));
    if (!maxWidth || !start) continue;
    const size = fitSize(
      start,
      maxWidth,
      (candidate) => {
        node.setAttribute('font-size', String(candidate));
        return node.getComputedTextLength();
      },
      FIT_FLOOR_MM,
      FIT_STEP_MM,
    );
    node.setAttribute('font-size', String(size));
    // The dominant code hangs FROM a top edge rather than sitting ON a fixed
    // baseline, so a shrunk one has to move up with it or it drifts into the
    // product line below.
    const top = node.dataset.fitTop;
    if (top) node.setAttribute('y', String(Number(top) + size));
    if (size < start) shrunk += 1;
  }
  return shrunk;
}
