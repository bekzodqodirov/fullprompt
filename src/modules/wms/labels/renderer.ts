import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import { cjkSubsetFor } from './cjk-font';

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
const PAGE = 100 * MM;

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

/** Shrink font size until the text fits maxWidth. */
function fitSize(font: PDFFont, text: string, startSize: number, maxWidth: number): number {
  let size = startSize;
  while (size > 6 && font.widthOfTextAtSize(text, size) > maxWidth) size -= 1;
  return size;
}

async function drawLabel(
  page: PDFPage,
  doc: PDFDocument,
  label: LabelData,
  fonts: Fonts,
): Promise<void> {
  const margin = 4 * MM;
  const width = PAGE - margin * 2;
  const black = rgb(0, 0, 0);

  // --- Top row: WH code (huge, sort-at-a-glance) + date + receipt no ---
  page.drawText(label.warehouseCode, {
    x: margin,
    y: PAGE - margin - 9 * MM,
    size: 9 * MM,
    font: fonts.bold,
    color: black,
  });
  const dateText = label.dateLocal;
  page.drawText(dateText, {
    x: PAGE - margin - fonts.regular.widthOfTextAtSize(dateText, 11),
    y: PAGE - margin - 4 * MM,
    size: 11,
    font: fonts.regular,
    color: black,
  });
  page.drawText(label.receiptNumber, {
    x: PAGE - margin - fonts.regular.widthOfTextAtSize(label.receiptNumber, 10),
    y: PAGE - margin - 8 * MM,
    size: 10,
    font: fonts.regular,
    color: black,
  });

  // --- Dominant element: client code + letter (~22 mm tall, spec §7).
  // Unclaimed cargo keeps whatever marking was on the box (route passes
  // `444-A`) so the sticker matches the physical writing; a small #UNKNOWN
  // marker below flags it as unresolved.
  const codeText = label.clientCodeWithLetter;
  const codeSize = fitSize(fonts.bold, codeText, 22 * MM, width);
  page.drawText(codeText, {
    x: (PAGE - fonts.bold.widthOfTextAtSize(codeText, codeSize)) / 2,
    y: PAGE - margin - 14 * MM - codeSize,
    size: codeSize,
    font: fonts.bold,
    color: black,
  });
  if (label.unclaimed && codeText !== '#UNKNOWN') {
    const marker = '#UNKNOWN';
    page.drawText(marker, {
      x: (PAGE - fonts.bold.widthOfTextAtSize(marker, 12)) / 2,
      y: PAGE - margin - 37 * MM,
      size: 12,
      font: fonts.bold,
      color: black,
    });
  }

  // --- Product zh (ru) ---
  const productText = label.productRu
    ? `${label.productZh} (${label.productRu})`
    : label.productZh;
  const productSize = fitSize(fonts.cjk, productText, 14, width);
  page.drawText(productText, {
    x: margin,
    y: PAGE - margin - 42 * MM,
    size: productSize,
    font: fonts.cjk,
    color: black,
  });

  // --- Box i/N, weight, dims ---
  const detailParts = [`Box ${label.boxSeq} / ${label.boxTotal}`];
  if (label.weightKg) detailParts.push(`${label.weightKg} kg`);
  if (label.dimsCm) detailParts.push(label.dimsCm);
  page.drawText(detailParts.join('    '), {
    x: margin,
    y: PAGE - margin - 50 * MM,
    size: 12,
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
  const qrSize = 34 * MM;
  page.drawImage(qrImage, { x: margin, y: margin, width: qrSize, height: qrSize });

  const textX = margin + qrSize + 4 * MM;
  const codeFontSize = fitSize(fonts.bold, label.shortCode, 16, PAGE - textX - margin);
  page.drawText(label.shortCode, {
    x: textX,
    y: margin + qrSize / 2 + 2 * MM,
    size: codeFontSize,
    font: fonts.bold,
    color: black,
  });
  page.drawText('GSR LOGISTICS', {
    x: textX,
    y: margin + qrSize / 2 - 5 * MM,
    size: 10,
    font: fonts.regular,
    color: black,
  });
  if (label.unclaimed) {
    page.drawText(label.receiptNumber, {
      x: textX,
      y: margin + qrSize / 2 - 10 * MM,
      size: 10,
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
  const margin = 4 * MM;
  const width = PAGE - margin * 2;
  const black = rgb(0, 0, 0);

  page.drawText(label.warehouseCode, {
    x: margin,
    y: PAGE - margin - 9 * MM,
    size: 9 * MM,
    font: bold,
    color: black,
  });
  const marker = label.kind === 'karkas' ? 'КАРКАС' : 'ЯЩИК';
  page.drawText(marker, {
    x: PAGE - margin - cjk.widthOfTextAtSize(marker, 18),
    y: PAGE - margin - 7 * MM,
    size: 18,
    font: cjk,
    color: black,
  });
  page.drawText(label.dateLocal, {
    x: PAGE - margin - regular.widthOfTextAtSize(label.dateLocal, 11),
    y: PAGE - margin - 11 * MM,
    size: 11,
    font: regular,
    color: black,
  });

  const codeSize = fitSize(bold, label.clientCode, 22 * MM, width);
  page.drawText(label.clientCode, {
    x: (PAGE - bold.widthOfTextAtSize(label.clientCode, codeSize)) / 2,
    y: PAGE - margin - 14 * MM - codeSize,
    size: codeSize,
    font: bold,
    color: black,
  });

  const contentsText = `${label.boxCount} 📦  ${label.contents}`.replace('📦', 'kor.');
  const contentsSize = fitSize(cjk, contentsText, 14, width);
  page.drawText(contentsText, {
    x: margin,
    y: PAGE - margin - 42 * MM,
    size: contentsSize,
    font: cjk,
    color: black,
  });

  const detailParts: string[] = [];
  if (label.weightKg) detailParts.push(`${label.weightKg} kg`);
  if (label.dimsCm) detailParts.push(label.dimsCm);
  if (detailParts.length) {
    page.drawText(detailParts.join('    '), {
      x: margin,
      y: PAGE - margin - 50 * MM,
      size: 12,
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
  const qrSize = 34 * MM;
  page.drawImage(qrImage, { x: margin, y: margin, width: qrSize, height: qrSize });
  const textX = margin + qrSize + 4 * MM;
  const codeFontSize = fitSize(bold, label.code, 16, PAGE - textX - margin);
  page.drawText(label.code, {
    x: textX,
    y: margin + qrSize / 2 + 2 * MM,
    size: codeFontSize,
    font: bold,
    color: black,
  });
  page.drawText('GSR LOGISTICS', {
    x: textX,
    y: margin + qrSize / 2 - 5 * MM,
    size: 10,
    font: regular,
    color: black,
  });

  return doc.save();
}
