import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import { cjkSubsetFor } from './cjk-font';
import {
  BOX_LABEL,
  CRATE_LABEL,
  FIT_FLOOR_MM,
  FIT_STEP_MM,
  LABEL_MM,
  MARGIN_MM,
  fitSize as fitToWidth,
} from './geometry';

/**
 * Label ("sticker") rendering — spec §7. 100×100 mm thermal, one page per
 * box. QR payload = box short code string only. The `LabelRenderer`
 * interface keeps the door open for a direct TSPL/ZPL driver later.
 */

export interface LabelData {
  warehouseCode: string;
  /** Warehouse-local date, already formatted (dd.MM.yyyy). */
  dateLocal: string;
  receiptNumber: string;
  /**
   * `GS777-A`; unclaimed cargo prints the marking written on the box
   * (`444-A`, owner's request) or `#UNKNOWN` when there is none.
   */
  clientCodeWithLetter: string;
  unclaimed: boolean;
  productZh: string;
  productRu: string | null;
  boxSeq: number;
  boxTotal: number;
  weightKg: string | null;
  dimsCm: string | null;
  shortCode: string;
}

export interface LabelRenderer {
  render(labels: LabelData[]): Promise<Uint8Array>;
}

const MM = 72 / 25.4; // pt per mm
const PAGE = LABEL_MM * MM;

/**
 * The geometry is written in millimetres from the TOP (geometry.ts, shared
 * with the SVG sticker); pdf-lib measures in points from the BOTTOM. These
 * four functions are the whole conversion, so no coordinate is ever converted
 * by hand at a call site — which is how the two renderers stay the same
 * sticker.
 */
const y = (topMm: number) => (LABEL_MM - topMm) * MM;
const x = (leftMm: number) => leftMm * MM;
const size = (sizeMm: number) => sizeMm * MM;
const widthMm = (font: PDFFont, text: string, sizeMm: number) =>
  font.widthOfTextAtSize(text, size(sizeMm)) / MM;

export class PdfLabelRenderer implements LabelRenderer {
  async render(labels: LabelData[]): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    // HarfBuzz-subsetted to this document's characters; fontkit's own
    // subsetter drops CJK glyphs (see cjk-font.ts), hence subset: false.
    const cjkBytes = await cjkSubsetFor(labels.flatMap((l) => [l.productZh, l.productRu]));
    const cjk = await doc.embedFont(cjkBytes, { subset: false });

    for (const label of labels) {
      const page = doc.addPage([PAGE, PAGE]);
      await drawLabel(page, doc, label, { bold, regular, cjk });
    }
    return doc.save();
  }
}

interface Fonts {
  bold: PDFFont;
  regular: PDFFont;
  cjk: PDFFont;
}

/**
 * Shrink until it fits, measured in millimetres.
 *
 * The stepping and the floor come from `geometry.ts` so the browser's fitter
 * cannot disagree about when a code is too long — the only difference between
 * the two is how a string is measured.
 */
function fitMm(font: PDFFont, text: string, startMm: number, maxMm: number): number {
  return fitToWidth(
    startMm,
    maxMm,
    (candidate) => widthMm(font, text, candidate),
    FIT_FLOOR_MM,
    FIT_STEP_MM,
  );
}

async function drawLabel(
  page: PDFPage,
  doc: PDFDocument,
  label: LabelData,
  fonts: Fonts,
): Promise<void> {
  const g = BOX_LABEL;
  const black = rgb(0, 0, 0);
  const centre = (font: PDFFont, text: string, sizeMm: number) =>
    x(LABEL_MM / 2 - widthMm(font, text, sizeMm) / 2);
  const rightOf = (font: PDFFont, text: string, sizeMm: number) =>
    x(LABEL_MM - MARGIN_MM - widthMm(font, text, sizeMm));

  // --- Top row: WH code (huge, sort-at-a-glance) + date + receipt no ---
  page.drawText(label.warehouseCode, {
    x: x(g.warehouseCode.x),
    y: y(g.warehouseCode.baseline),
    size: size(g.warehouseCode.size),
    font: fonts.bold,
    color: black,
  });
  page.drawText(label.dateLocal, {
    x: rightOf(fonts.regular, label.dateLocal, g.date.size),
    y: y(g.date.baseline),
    size: size(g.date.size),
    font: fonts.regular,
    color: black,
  });
  page.drawText(label.receiptNumber, {
    x: rightOf(fonts.regular, label.receiptNumber, g.receiptNumber.size),
    y: y(g.receiptNumber.baseline),
    size: size(g.receiptNumber.size),
    font: fonts.regular,
    color: black,
  });

  // Unclaimed cargo keeps whatever marking was on the box (`444-A`) so the
  // sticker matches the physical writing, and says separately that nobody has
  // claimed it. That marker sits ABOVE the code, not across it — see
  // BOX_LABEL.unknownMark.
  if (label.unclaimed && label.clientCodeWithLetter !== '#UNKNOWN') {
    const marker = '#UNKNOWN';
    page.drawText(marker, {
      x: centre(fonts.bold, marker, g.unknownMark.size),
      y: y(g.unknownMark.baseline),
      size: size(g.unknownMark.size),
      font: fonts.bold,
      color: black,
    });
  }

  // --- Dominant element: client code + letter (spec §7). It hangs from a top
  // edge, so a shrunk code moves up rather than down into the product line.
  const codeText = label.clientCodeWithLetter;
  const codeSize = fitMm(fonts.bold, codeText, g.clientCode.maxSize, g.clientCode.maxWidth);
  page.drawText(codeText, {
    x: centre(fonts.bold, codeText, codeSize),
    y: y(g.clientCode.top + codeSize),
    size: size(codeSize),
    font: fonts.bold,
    color: black,
  });

  // --- Product zh (ru) ---
  const productText = label.productRu
    ? `${label.productZh} (${label.productRu})`
    : label.productZh;
  page.drawText(productText, {
    x: x(g.product.x),
    y: y(g.product.baseline),
    size: size(fitMm(fonts.cjk, productText, g.product.maxSize, g.product.maxWidth)),
    font: fonts.cjk,
    color: black,
  });

  // --- Box i/N, weight, dims ---
  const detailParts = [`Box ${label.boxSeq} / ${label.boxTotal}`];
  if (label.weightKg) detailParts.push(`${label.weightKg} kg`);
  if (label.dimsCm) detailParts.push(label.dimsCm);
  page.drawText(detailParts.join('    '), {
    x: x(g.detail.x),
    y: y(g.detail.baseline),
    size: size(g.detail.size),
    font: fonts.regular,
    color: black,
  });

  // --- QR (≥32×32 mm with quiet zone) + fallback text ---
  const qrPng = await QRCode.toBuffer(label.shortCode, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 400,
  });
  const qrImage = await doc.embedPng(qrPng);
  page.drawImage(qrImage, {
    x: x(g.qr.x),
    // drawImage anchors at the image's BOTTOM-left, and the geometry states a
    // top edge.
    y: y(g.qr.top + g.qr.size),
    width: size(g.qr.size),
    height: size(g.qr.size),
  });

  page.drawText(label.shortCode, {
    x: x(g.shortCode.x),
    y: y(g.shortCode.baseline),
    size: size(fitMm(fonts.bold, label.shortCode, g.shortCode.maxSize, g.shortCode.maxWidth)),
    font: fonts.bold,
    color: black,
  });
  page.drawText('GSR LOGISTICS', {
    x: x(g.wordmark.x),
    y: y(g.wordmark.baseline),
    size: size(g.wordmark.size),
    font: fonts.regular,
    color: black,
  });
  if (label.unclaimed) {
    page.drawText(label.receiptNumber, {
      x: x(g.unclaimedRef.x),
      y: y(g.unclaimedRef.baseline),
      size: size(g.unclaimedRef.size),
      font: fonts.regular,
      color: black,
    });
  }
}

export const labelRenderer: LabelRenderer = new PdfLabelRenderer();

// ---------------------------------------------------------------------------
// Crate label (spec 6.2): dominant client code, KARKAS/YASHIK marker, contents
// summary ("18 boxes / GS777: A×10, B×8"), QR = crate code.
// ---------------------------------------------------------------------------

export interface CrateLabelData {
  warehouseCode: string;
  dateLocal: string;
  code: string;
  clientCode: string;
  /** 'yashik' | 'karkas' — printed as ЯЩИК / КАРКАС. */
  kind: string;
  boxCount: number;
  /** e.g. "A×10, B×8". */
  contents: string;
  weightKg: string | null;
  dimsCm: string | null;
}

export async function renderCrateLabel(label: CrateLabelData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const cjkBytes = await cjkSubsetFor(['ЯЩИК КАРКАС', label.contents, label.clientCode]);
  const cjk = await doc.embedFont(cjkBytes, { subset: false });

  const page = doc.addPage([PAGE, PAGE]);
  const g = CRATE_LABEL;
  const black = rgb(0, 0, 0);
  const rightOf = (font: PDFFont, text: string, sizeMm: number) =>
    x(LABEL_MM - MARGIN_MM - widthMm(font, text, sizeMm));

  page.drawText(label.warehouseCode, {
    x: x(g.warehouseCode.x),
    y: y(g.warehouseCode.baseline),
    size: size(g.warehouseCode.size),
    font: bold,
    color: black,
  });
  const marker = label.kind === 'karkas' ? 'КАРКАС' : 'ЯЩИК';
  page.drawText(marker, {
    x: rightOf(cjk, marker, g.kind.size),
    y: y(g.kind.baseline),
    size: size(g.kind.size),
    font: cjk,
    color: black,
  });
  page.drawText(label.dateLocal, {
    x: rightOf(regular, label.dateLocal, g.date.size),
    y: y(g.date.baseline),
    size: size(g.date.size),
    font: regular,
    color: black,
  });

  const codeSize = fitMm(bold, label.clientCode, g.clientCode.maxSize, g.clientCode.maxWidth);
  page.drawText(label.clientCode, {
    x: x(LABEL_MM / 2 - widthMm(bold, label.clientCode, codeSize) / 2),
    y: y(g.clientCode.top + codeSize),
    size: size(codeSize),
    font: bold,
    color: black,
  });

  const contentsText = `${label.boxCount} kor. ${label.contents}`;
  page.drawText(contentsText, {
    x: x(g.contents.x),
    y: y(g.contents.baseline),
    size: size(fitMm(cjk, contentsText, g.contents.maxSize, g.contents.maxWidth)),
    font: cjk,
    color: black,
  });

  const detailParts: string[] = [];
  if (label.weightKg) detailParts.push(`${label.weightKg} kg`);
  if (label.dimsCm) detailParts.push(label.dimsCm);
  if (detailParts.length) {
    page.drawText(detailParts.join('    '), {
      x: x(g.detail.x),
      y: y(g.detail.baseline),
      size: size(g.detail.size),
      font: regular,
      color: black,
    });
  }

  const qrPng = await QRCode.toBuffer(label.code, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 400,
  });
  const qrImage = await doc.embedPng(qrPng);
  page.drawImage(qrImage, {
    x: x(g.qr.x),
    y: y(g.qr.top + g.qr.size),
    width: size(g.qr.size),
    height: size(g.qr.size),
  });
  page.drawText(label.code, {
    x: x(g.code.x),
    y: y(g.code.baseline),
    size: size(fitMm(bold, label.code, g.code.maxSize, g.code.maxWidth)),
    font: bold,
    color: black,
  });
  page.drawText('GSR LOGISTICS', {
    x: x(g.wordmark.x),
    y: y(g.wordmark.baseline),
    size: size(g.wordmark.size),
    font: regular,
    color: black,
  });

  return doc.save();
}
