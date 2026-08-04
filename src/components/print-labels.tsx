/**
 * The one control that starts a sticker print.
 *
 * It used to be the whole mechanism — fetch the PDF, hand it to the share
 * sheet, fall back to a new tab — and it carried two controls per button
 * because neither route works everywhere (#224, #225). The owner then asked
 * for the thing both of them are only ever a way of REACHING: "qaysi
 * pagelarni qaysi printer deb belgilaydigan oyna" — the phone's own print
 * panel, printer and page range.
 *
 * That panel is `window.print()`, and only a document can open it. So this is
 * now a link to the sheet at `/print/…`, which renders the same stickers as
 * HTML and opens the dialog itself. Every other way out — the share sheet for
 * AirPrint and the printer's own app, the PDF for Android's RawBT — lives on
 * that screen, where there is room to label them and where an operator who
 * needs a different one can see it instead of being told about it by phone.
 *
 * A plain anchor rather than `next/link`: the print route carries an `@page`
 * rule and must arrive as its own document.
 */
export function PrintLabels({
  href,
  label,
  variant = 'primary',
}: {
  /** The print sheet, e.g. `/print/receipts/<id>?lotId=<id>`. */
  href: string;
  /** Button text — the caller already has the translation in context. */
  label: string;
  variant?: 'primary' | 'secondary';
}) {
  return (
    // A plain <a>, not next/link: the sheet must arrive as its own document
    // so the route-scoped @page rule loads with it.
    <a
      href={href}
      data-testid="print-labels"
      className={`${variant === 'primary' ? 'btn-primary' : 'btn-secondary'} flex w-full items-center justify-center`}
    >
      🖨 {label}
    </a>
  );
}
