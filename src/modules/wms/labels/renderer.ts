import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';

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
  /** `GS777-A`; unclaimed prints `#UNKNOWN` + receipt number instead. */
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

let cachedCjkBytes: Buffer | null = null;
async function cjkFontBytes(): Promise<Buffer> {
  if (!cachedCjkBytes) {
    cachedCjkBytes = await readFile(
      path.join(process.cwd(), 'src/assets/fonts/NotoSansSC-Regular.otf'),
    );
  }
  return cachedCjkBytes;
}

export class PdfLabelRenderer implements LabelRenderer {
  async render(labels: LabelData[]): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const cjk = await doc.embedFont(await cjkFontBytes(), { subset: true });

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

  // --- Dominant element: client code + letter (~22 mm tall, spec §7) ---
  const codeText = label.unclaimed ? '#UNKNOWN' : label.clientCodeWithLetter;
  const codeSize = fitSize(fonts.bold, codeText, 22 * MM, width);
  page.drawText(codeText, {
    x: (PAGE - fonts.bold.widthOfTextAtSize(codeText, codeSize)) / 2,
    y: PAGE - margin - 14 * MM - codeSize,
    size: codeSize,
    font: fonts.bold,
    color: black,
  });

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
