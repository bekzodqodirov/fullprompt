import {
  BOX_LABEL,
  CRATE_LABEL,
  CONTENT_MM,
  LABEL_MM,
  MARGIN_MM,
} from '@/modules/wms/labels/geometry';
import type { LabelData } from '@/modules/wms/labels/renderer';

/**
 * The sticker as SVG, so the phone's own print dialog can put it on paper.
 *
 * SVG rather than divs, for one reason that decides it: `<text y>` in SVG is
 * the BASELINE, exactly like pdf-lib's `drawText` y. So this file and the PDF
 * renderer position every mark from the same numbers in geometry.ts, and
 * neither has to convert through a font's ascent — which is the step that
 * would have made the HTML sticker drift a millimetre or two from the PDF one
 * and put two designs on one truck.
 *
 * A `viewBox` of 0 0 100 100 on a 100×100 mm box means one user unit IS one
 * millimetre, at any zoom and any printer resolution.
 *
 * Black on white, hard-coded: the app has a dark theme and a sticker printed
 * white-on-black is a wasted label and a ribbon.
 */

/** Marks text that must shrink to fit; the client fitter reads these. */
function fitAttrs(maxWidth: number) {
  return { 'data-fit': maxWidth };
}

export function BoxLabelSvg({ label, qr }: { label: LabelData; qr: string }) {
  const g = BOX_LABEL;
  const product = label.productRu
    ? `${label.productZh} (${label.productRu})`
    : label.productZh;
  const detail = [`Box ${label.boxSeq} / ${label.boxTotal}`];
  if (label.weightKg) detail.push(`${label.weightKg} kg`);
  if (label.dimsCm) detail.push(label.dimsCm);
  // The PDF joins with four spaces; HTML would collapse them to one, so the
  // separator is explicit rather than whitespace.
  const detailText = detail.join('  ');

  return (
    <svg
      viewBox={`0 0 ${LABEL_MM} ${LABEL_MM}`}
      xmlns="http://www.w3.org/2000/svg"
      className="label-svg"
      data-testid="label"
      data-code={label.shortCode}
    >
      <rect width={LABEL_MM} height={LABEL_MM} fill="#fff" />

      <text x={g.warehouseCode.x} y={g.warehouseCode.baseline} fontSize={g.warehouseCode.size} fontWeight="700">
        {label.warehouseCode}
      </text>
      <text x={g.date.x} y={g.date.baseline} fontSize={g.date.size} textAnchor="end">
        {label.dateLocal}
      </text>
      <text
        x={g.receiptNumber.x}
        y={g.receiptNumber.baseline}
        fontSize={g.receiptNumber.size}
        textAnchor="end"
      >
        {label.receiptNumber}
      </text>

      {/* Unclaimed cargo keeps whatever marking was written on the box, and
          says separately that nobody has claimed it yet. */}
      {label.unclaimed && label.clientCodeWithLetter !== '#UNKNOWN' && (
        <text
          x={LABEL_MM / 2}
          y={g.unknownMark.baseline}
          fontSize={g.unknownMark.size}
          fontWeight="700"
          textAnchor="middle"
        >
          #UNKNOWN
        </text>
      )}

      {/* The dominant element. Its baseline moves with the fitted size, so
          the fitter sets both — see `data-fit-top`. */}
      <text
        x={LABEL_MM / 2}
        y={g.clientCode.top + g.clientCode.maxSize}
        fontSize={g.clientCode.maxSize}
        fontWeight="700"
        textAnchor="middle"
        data-fit-top={g.clientCode.top}
        {...fitAttrs(g.clientCode.maxWidth)}
      >
        {label.clientCodeWithLetter}
      </text>

      <text
        x={g.product.x}
        y={g.product.baseline}
        fontSize={g.product.maxSize}
        {...fitAttrs(g.product.maxWidth)}
      >
        {product}
      </text>
      <text x={g.detail.x} y={g.detail.baseline} fontSize={g.detail.size}>
        {detailText}
      </text>

      <QrImage qr={qr} x={g.qr.x} y={g.qr.top} size={g.qr.size} />

      <text
        x={g.shortCode.x}
        y={g.shortCode.baseline}
        fontSize={g.shortCode.maxSize}
        fontWeight="700"
        {...fitAttrs(g.shortCode.maxWidth)}
      >
        {label.shortCode}
      </text>
      <text x={g.wordmark.x} y={g.wordmark.baseline} fontSize={g.wordmark.size}>
        GSR LOGISTICS
      </text>
      {label.unclaimed && (
        <text x={g.unclaimedRef.x} y={g.unclaimedRef.baseline} fontSize={g.unclaimedRef.size}>
          {label.receiptNumber}
        </text>
      )}
    </svg>
  );
}

export interface CrateLabelView {
  warehouseCode: string;
  dateLocal: string;
  code: string;
  clientCode: string;
  kind: string;
  boxCount: number;
  contents: string;
  weightKg: string | null;
  dimsCm: string | null;
}

export function CrateLabelSvg({ label, qr }: { label: CrateLabelView; qr: string }) {
  const g = CRATE_LABEL;
  const detail = [];
  if (label.weightKg) detail.push(`${label.weightKg} kg`);
  if (label.dimsCm) detail.push(label.dimsCm);

  return (
    <svg
      viewBox={`0 0 ${LABEL_MM} ${LABEL_MM}`}
      xmlns="http://www.w3.org/2000/svg"
      className="label-svg"
      data-testid="label"
      data-code={label.code}
    >
      <rect width={LABEL_MM} height={LABEL_MM} fill="#fff" />

      <text x={g.warehouseCode.x} y={g.warehouseCode.baseline} fontSize={g.warehouseCode.size} fontWeight="700">
        {label.warehouseCode}
      </text>
      <text x={g.kind.x} y={g.kind.baseline} fontSize={g.kind.size} textAnchor="end">
        {label.kind === 'karkas' ? 'КАРКАС' : 'ЯЩИК'}
      </text>
      <text x={g.date.x} y={g.date.baseline} fontSize={g.date.size} textAnchor="end">
        {label.dateLocal}
      </text>

      <text
        x={LABEL_MM / 2}
        y={g.clientCode.top + g.clientCode.maxSize}
        fontSize={g.clientCode.maxSize}
        fontWeight="700"
        textAnchor="middle"
        data-fit-top={g.clientCode.top}
        {...fitAttrs(g.clientCode.maxWidth)}
      >
        {label.clientCode}
      </text>

      <text
        x={g.contents.x}
        y={g.contents.baseline}
        fontSize={g.contents.maxSize}
        {...fitAttrs(CONTENT_MM)}
      >
        {`${label.boxCount} kor. ${label.contents}`}
      </text>
      {detail.length > 0 && (
        <text x={g.detail.x} y={g.detail.baseline} fontSize={g.detail.size}>
          {detail.join('  ')}
        </text>
      )}

      <QrImage qr={qr} x={g.qr.x} y={g.qr.top} size={g.qr.size} />

      <text
        x={g.code.x}
        y={g.code.baseline}
        fontSize={g.code.maxSize}
        fontWeight="700"
        {...fitAttrs(g.code.maxWidth)}
      >
        {label.code}
      </text>
      <text x={g.wordmark.x} y={g.wordmark.baseline} fontSize={g.wordmark.size}>
        GSR LOGISTICS
      </text>
    </svg>
  );
}

/**
 * The QR, nested as SVG rather than dropped in as an <img>.
 *
 * A print engine does not have to wait for an image to decode before it
 * paints, and this sheet opens the print dialog itself — a raster QR can lose
 * that race and print blank, which is a box that cannot be scanned onto a
 * truck. Nested SVG is in the DOM the moment the HTML lands.
 *
 * The generator emits its own `width`/`height`; the outer <svg> here places
 * and sizes it, and the inner viewBox does the rest.
 */
function QrImage({ qr, x, y, size }: { qr: string; x: number; y: number; size: number }) {
  return (
    <svg
      x={x}
      y={y}
      width={size}
      height={size}
      viewBox={qrViewBox(qr)}
      // The generator's own markup: paths only, no script, no external ref.
      dangerouslySetInnerHTML={{ __html: qrInner(qr) }}
    />
  );
}

/** The generator always emits `viewBox="0 0 N N"`; fall back to the default. */
function qrViewBox(svg: string): string {
  return /viewBox="([^"]+)"/.exec(svg)?.[1] ?? '0 0 25 25';
}

function qrInner(svg: string): string {
  return svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
}

/** The margin around a sheet of labels on screen (never in print). */
export const SHEET_GAP_MM = MARGIN_MM;
