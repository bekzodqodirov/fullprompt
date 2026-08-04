/**
 * Where every mark on a 100×100 mm sticker sits — stated once.
 *
 * There are two renderers now. `renderer.ts` draws the PDF with pdf-lib
 * (bottom-left origin, points), `label-svg.tsx` draws the same sticker as
 * inline SVG so the phone's own print dialog can put it on paper (top-left
 * origin, millimetres). They must produce the SAME sticker: a warehouse
 * cannot have two sticker designs depending on which button the operator
 * pressed, and a customs officer comparing two boxes from one truck must not
 * see two layouts.
 *
 * So the geometry lives here, in the ONE coordinate system both can convert
 * from: millimetres, measured from the TOP-LEFT, with text positioned by its
 * BASELINE — which is what both pdf-lib's `drawText` y and SVG's `<text> y`
 * already mean, so neither renderer has to guess at font metrics.
 */

/** The sticker. Thermal 100×100 mm, one per box (spec §7). */
export const LABEL_MM = 100;
export const MARGIN_MM = 4;
export const CONTENT_MM = LABEL_MM - MARGIN_MM * 2;
export const RIGHT_MM = LABEL_MM - MARGIN_MM;

/** Points to millimetres. The sizes below were chosen in pt; the page is mm. */
export const ptMm = (points: number) => (points * 25.4) / 72;

export const QR_MM = 34;
/** The text column beside the QR. */
export const QR_TEXT_X_MM = MARGIN_MM + QR_MM + 4;

export const BOX_LABEL = {
  /** Huge, so a pallet can be sorted by warehouse at arm's length. */
  warehouseCode: { baseline: 13, x: MARGIN_MM, size: 9 },
  date: { baseline: 8, x: RIGHT_MM, size: ptMm(11) },
  receiptNumber: { baseline: 12, x: RIGHT_MM, size: ptMm(10) },
  /**
   * The dominant element (spec §7). Its baseline is NOT fixed: the size
   * shrinks to fit 92 mm, and the baseline follows it down from this top.
   * `GS777-A` clears the limit by 0.3 mm, so `GS777-W` already shrinks —
   * anything that hard-codes a baseline here is wrong on live data.
   */
  clientCode: { top: 18, maxSize: 22, maxWidth: CONTENT_MM },
  /**
   * Moved up out of the client code (was baseline 41 mm).
   *
   * On the path it exists for — unclaimed cargo carrying the marking written
   * on the box, `444-A` — the code never shrinks, so its ink ran from 24.2 mm
   * to a baseline at 40.0 mm while this marker's ink started at 38.0 mm: a
   * 2 mm band where both printed, dead centre, on the one sticker whose whole
   * job is to be read by a human looking for an owner.
   */
  unknownMark: { baseline: 18, size: ptMm(12) },
  product: { baseline: 46, x: MARGIN_MM, maxSize: ptMm(14), maxWidth: CONTENT_MM },
  detail: { baseline: 54, x: MARGIN_MM, size: ptMm(12) },
  /** A box top, not a baseline — it is an image. */
  qr: { top: LABEL_MM - MARGIN_MM - QR_MM, x: MARGIN_MM, size: QR_MM },
  shortCode: {
    baseline: 77,
    x: QR_TEXT_X_MM,
    maxSize: ptMm(16),
    maxWidth: RIGHT_MM - QR_TEXT_X_MM,
  },
  wordmark: { baseline: 84, x: QR_TEXT_X_MM, size: ptMm(10) },
  /** Only on unclaimed cargo: which receipt to look the box up in. */
  unclaimedRef: { baseline: 89, x: QR_TEXT_X_MM, size: ptMm(10) },
} as const;

export const CRATE_LABEL = {
  warehouseCode: { baseline: 13, x: MARGIN_MM, size: 9 },
  kind: { baseline: 11, x: RIGHT_MM, size: ptMm(18) },
  date: { baseline: 15, x: RIGHT_MM, size: ptMm(11) },
  clientCode: { top: 18, maxSize: 22, maxWidth: CONTENT_MM },
  contents: { baseline: 46, x: MARGIN_MM, maxSize: ptMm(14), maxWidth: CONTENT_MM },
  detail: { baseline: 54, x: MARGIN_MM, size: ptMm(12) },
  qr: { top: LABEL_MM - MARGIN_MM - QR_MM, x: MARGIN_MM, size: QR_MM },
  code: {
    baseline: 77,
    x: QR_TEXT_X_MM,
    maxSize: ptMm(16),
    maxWidth: RIGHT_MM - QR_TEXT_X_MM,
  },
  wordmark: { baseline: 84, x: QR_TEXT_X_MM, size: ptMm(10) },
} as const;

/**
 * Shrink until it fits — the same rule in both renderers.
 *
 * Only the MEASURING differs: pdf-lib knows the width of a string in an
 * embedded font, and the browser knows it from `getComputedTextLength()` on a
 * laid-out `<text>`. The stepping, the floor and the "≤ maxWidth wins" rule
 * are the decision, so they are here and are what a test can call (#166).
 *
 * `floor` is a real limit, not a formality: below it the text is unreadable
 * on a thermal print and it is better to let a freak-long code overrun than
 * to print a line nobody can make out.
 */
export function fitSize(
  startSize: number,
  maxWidth: number,
  measure: (size: number) => number,
  floor: number,
  step: number,
): number {
  let size = startSize;
  while (size > floor && measure(size) > maxWidth) size -= step;
  return size;
}

/** The PDF's floor of 6 pt, expressed where the sticker is measured in mm. */
export const FIT_FLOOR_MM = ptMm(6);
export const FIT_STEP_MM = ptMm(1);
