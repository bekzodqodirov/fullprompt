import fontkit from '@pdf-lib/fontkit';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { getSetting } from '../../platform/settings/service';
import { cjkSubsetFor, pdfTextCleaner } from '../labels/cjk-font';
import { clientLabels, type ClientLocale } from '../../platform/telegram/client-labels';
import { offerLines, type OfferInput } from './offer';

/**
 * The offer as an A4 sheet the seller can send a customer — the round-112
 * shape, after the owner's «CRMdan pdf komm. invoysni chiroyli qilib ber».
 *
 * WHAT IT PRINTS, and the rule behind each part:
 *  - the company: logo (`public/logo-full.png`) + name / address / phone
 *    from settings — the SAME three settings every VED document reads;
 *  - a document line: the deal's code (a lead has none) and the OFFER's date,
 *    never render time — a sheet re-downloaded next month says the day it was
 *    promised;
 *  - the customer: name, code, phone from the book;
 *  - the GOODS: read from the request's own items (`calc_request_items`) and
 *    NOT from the sealed breakdown — a yolkira seal carries no groups and the
 *    breakdown's items live only under groups, so the commonest quote would
 *    print an empty table. Descriptors ONLY: name, quantity, kg, m³. No price
 *    per row and no TNVED: a per-row price decomposes the total (#781), and
 *    the grouping is the VED's working, not the customer's;
 *  - the money rows from `offerLines()` — the SAME rows the Telegram text
 *    carries, so the sheet and the message cannot disagree;
 *  - who to call: the seller's name and phone;
 *  - the footer and a signature line.
 *
 * `OfferSheetInput` is a PURE projection with no money field on an item, and
 * `tests/unit/offer-sheet.test.ts` pins that structurally — the snapshot the
 * route could have handed over carries bazaUsd and the customs rates.
 *
 * The font is the label printer's subsetted NotoSansSC — the one embedded
 * face that draws Cyrillic, Latin and the Uzbek apostrophe — and EVERY string
 * that reaches a page goes through `pdfTextCleaner()` and into the subset
 * list, or a Chinese product label prints as boxes with no error (#788).
 * pdf-lib wraps nothing: every cell is cut to its column by measured width.
 */
export interface OfferSheetItem {
  seq: number;
  label: string;
  quantity: number | null;
  unit: string | null;
  weightKg: number | null;
  volumeM3: number | null;
}

export interface OfferSheetInput extends OfferInput {
  clientCode: string | null;
  clientPhone: string | null;
  /** The deal's code; a lead's offer has no document number. */
  docNo: string | null;
  /** When the offer was made — the sheet's date. */
  offeredAt: Date;
  managerName: string | null;
  managerPhone: string | null;
  items: OfferSheetItem[];
}

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 48;
const CONTENT_W = PAGE_W - 2 * MARGIN;

/** Columns of the goods table: № · goods · qty · kg · m³ (widths sum to CONTENT_W). */
type ColKey = 'no' | 'goods' | 'qty' | 'kg' | 'm3';
const COLS: { key: ColKey; w: number; align: 'left' | 'right' }[] = [
  { key: 'no', w: 28, align: 'right' },
  { key: 'goods', w: CONTENT_W - 28 - 80 - 70 - 70, align: 'left' },
  { key: 'qty', w: 80, align: 'right' },
  { key: 'kg', w: 70, align: 'right' },
  { key: 'm3', w: 70, align: 'right' },
];

function num(value: number | null, digits: number): string {
  if (value === null || !Number.isFinite(value)) return '';
  return value.toFixed(digits).replace(/\.?0+$/, (m) => (m.startsWith('.') ? '' : m));
}

function fmtDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

/** Cut a string to a width, with an ellipsis, by MEASURING it — pdf-lib wraps nothing. */
function fit(text: string, font: PDFFont, size: number, maxW: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxW) return text;
  const ell = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (font.widthOfTextAtSize(text.slice(0, mid) + ell, size) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ell;
}

export async function buildOfferPdf(
  input: OfferSheetInput,
  locale: ClientLocale,
): Promise<Uint8Array> {
  const L = clientLabels(locale);
  const raw = offerLines(input, locale);
  const clean = await pdfTextCleaner();

  const company = clean(String(await getSetting('company_name')));
  const address = clean(String(await getSetting('company_address')));
  const phone = clean(String(await getSetting('company_phone')));
  const title = clean(raw.title);
  const footer = clean(raw.footer);
  const rows = raw.rows.map((r) => ({ label: clean(r.label), value: clean(r.value) }));
  const clientName = input.clientName ? clean(input.clientName) : null;
  const clientCode = input.clientCode ? clean(input.clientCode) : null;
  const clientPhone = input.clientPhone ? clean(input.clientPhone) : null;
  const docNo = input.docNo ? clean(input.docNo) : null;
  const date = fmtDate(input.offeredAt);
  const managerName = input.managerName ? clean(input.managerName) : null;
  const managerPhone = input.managerPhone ? clean(input.managerPhone) : null;
  const items = input.items.map((i) => ({
    ...i,
    label: clean(i.label),
    unit: i.unit ? clean(i.unit) : null,
  }));
  const SHEET_KEYS = [
    'sheetDocNo', 'sheetDate', 'sheetClient', 'sheetClientCode', 'sheetPhone',
    'sheetGoods', 'sheetColNo', 'sheetColGoods', 'sheetColQty', 'sheetColKg',
    'sheetColM3', 'sheetGoodsTotal', 'sheetManager', 'sheetSignature', 'sheetPage',
  ] as const;
  type SheetKey = (typeof SHEET_KEYS)[number];
  const labels = Object.fromEntries(SHEET_KEYS.map((k) => [k, clean(L[k])])) as Record<
    SheetKey,
    string
  >;
  const totalLabel = clean(L.offerTotal);

  // Every string that will be drawn, for the subset — a missing glyph is a
  // blank on the customer's paper and no error anywhere.
  const bytes = await cjkSubsetFor([
    company, address, phone, title, footer, date,
    clientName ?? '', clientCode ?? '', clientPhone ?? '', docNo ?? '',
    managerName ?? '', managerPhone ?? '',
    ...Object.values(labels),
    ...rows.flatMap((r) => [r.label, r.value]),
    ...items.flatMap((i) => [i.label, i.unit ?? '', num(i.quantity, 3), num(i.weightKg, 1), num(i.volumeM3, 3)]),
    '0123456789.,…',
  ]);

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  // `subset: false` — the bytes are already a HarfBuzz subset with GSUB cut
  // out; fontkit's subsetter is the one #103 removed (see cjk-font.ts, #881).
  const font = await doc.embedFont(bytes, { subset: false });
  const black = rgb(0, 0, 0);
  const grey = rgb(0.42, 0.42, 0.42);
  const line = rgb(0.8, 0.8, 0.8);
  const brand = rgb(0.77, 0.06, 0.06);

  // The logo, if the file is there; a missing file draws no logo and no error.
  let logo: PDFImage | null = null;
  try {
    const png = await readFile(path.join(process.cwd(), 'public', 'logo-full.png'));
    logo = await doc.embedPng(png);
  } catch {
    logo = null;
  }

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;

  const text = (
    t: string,
    x: number,
    size: number,
    opts: { color?: ReturnType<typeof rgb>; maxW?: number; align?: 'left' | 'right' } = {},
  ) => {
    const s = opts.maxW ? fit(t, font, size, opts.maxW) : t;
    const w = font.widthOfTextAtSize(s, size);
    const x0 = opts.align === 'right' ? x - w : x;
    page.drawText(s, { x: x0, y, size, font, color: opts.color ?? black });
  };

  /** The header every page carries: logo + company block + a rule. */
  const startPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    y = PAGE_H - MARGIN;
    let headerBottom = y;
    if (logo) {
      const h = 40;
      const w = (logo.width / logo.height) * h;
      page.drawImage(logo, { x: MARGIN, y: y - h, width: Math.min(w, 180), height: h });
      headerBottom = y - h;
    }
    // Company block on the right, right-aligned.
    let cy = y - 12;
    for (const [t, size, color] of [
      [company, 12, black],
      [address, 9, grey],
      [phone, 9, grey],
    ] as const) {
      if (!t || t === '—') continue;
      const w = font.widthOfTextAtSize(t, size);
      page.drawText(t, { x: PAGE_W - MARGIN - w, y: cy, size, font, color });
      cy -= size + 4;
    }
    y = Math.min(headerBottom, cy) - 10;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1, color: brand });
    y -= 22;
  };

  const ensure = (needed: number) => {
    if (y - needed < MARGIN + 30) {
      startPage();
      return true;
    }
    return false;
  };

  startPage();

  // ---- title + document line --------------------------------------
  text(title, MARGIN, 16);
  y -= 8;
  const docParts = [
    docNo ? `${labels.sheetDocNo}: ${docNo}` : null,
    `${labels.sheetDate}: ${date}`,
  ].filter(Boolean) as string[];
  y -= 12;
  text(docParts.join('   ·   '), MARGIN, 10, { color: grey });
  y -= 22;

  // ---- the customer -----------------------------------------------
  if (clientName || clientCode) {
    const parts = [
      clientName ? `${labels.sheetClient}: ${clientName}` : null,
      clientCode ? `${labels.sheetClientCode}: ${clientCode}` : null,
      clientPhone ? `${labels.sheetPhone}: ${clientPhone}` : null,
    ].filter(Boolean) as string[];
    for (const part of parts) {
      text(part, MARGIN, 10.5, { maxW: CONTENT_W });
      y -= 15;
    }
    y -= 8;
  }

  // ---- the goods table --------------------------------------------
  if (items.length > 0) {
    const rowH = 18;
    const drawHead = () => {
      text(labels.sheetGoods, MARGIN, 11);
      y -= 18;
      let x = MARGIN;
      page.drawRectangle({ x: MARGIN, y: y - 5, width: CONTENT_W, height: rowH, color: rgb(0.95, 0.95, 0.95) });
      const heads: Record<ColKey, string> = {
        no: labels.sheetColNo, goods: labels.sheetColGoods, qty: labels.sheetColQty,
        kg: labels.sheetColKg, m3: labels.sheetColM3,
      };
      for (const c of COLS) {
        const t = heads[c.key];
        if (c.align === 'right') text(t, x + c.w - 4, 9, { color: grey, align: 'right' });
        else text(t, x + 4, 9, { color: grey, maxW: c.w - 8 });
        x += c.w;
      }
      y -= rowH;
    };
    drawHead();
    let sumKg = 0;
    let sumM3 = 0;
    let anyKg = false;
    let anyM3 = false;
    for (const item of items) {
      if (ensure(rowH + 4)) drawHead();
      let x = MARGIN;
      const qty = item.quantity === null ? '' : `${num(item.quantity, 3)}${item.unit ? ' ' + item.unit : ''}`;
      const cells: Record<ColKey, string> = {
        no: String(item.seq),
        goods: item.label,
        qty,
        kg: num(item.weightKg, 1),
        m3: num(item.volumeM3, 3),
      };
      for (const c of COLS) {
        const t = cells[c.key];
        if (c.align === 'right') text(fit(t, font, 10, c.w - 8), x + c.w - 4, 10, { align: 'right' });
        else text(t, x + 4, 10, { maxW: c.w - 8 });
        x += c.w;
      }
      page.drawLine({ start: { x: MARGIN, y: y - 5 }, end: { x: PAGE_W - MARGIN, y: y - 5 }, thickness: 0.5, color: line });
      if (item.weightKg !== null) { sumKg += item.weightKg; anyKg = true; }
      if (item.volumeM3 !== null) { sumM3 += item.volumeM3; anyM3 = true; }
      y -= rowH;
    }
    if (anyKg || anyM3) {
      ensure(rowH);
      let x = MARGIN;
      const cells: Record<ColKey, string> = {
        no: '', goods: labels.sheetGoodsTotal, qty: '',
        kg: anyKg ? num(sumKg, 1) : '', m3: anyM3 ? num(sumM3, 3) : '',
      };
      for (const c of COLS) {
        const t = cells[c.key];
        if (c.align === 'right') text(t, x + c.w - 4, 10, { align: 'right' });
        else text(t, x + 4, 10, { maxW: c.w - 8 });
        x += c.w;
      }
      y -= rowH;
    }
    y -= 10;
  }

  // ---- the money rows: offerLines, verbatim -----------------------
  ensure(rows.length * 22 + 40);
  for (const row of rows) {
    const isTotal = row.label === totalLabel;
    const size = isTotal ? 15 : 11;
    if (ensure(isTotal ? 28 : 22)) { /* header redrawn */ }
    text(row.label, MARGIN, size, { color: isTotal ? black : grey, maxW: 240 });
    text(row.value, PAGE_W - MARGIN, size, { align: 'right' });
    y -= isTotal ? 28 : 22;
  }

  // ---- who to call + signature + footer ---------------------------
  y -= 6;
  ensure(70);
  if (managerName || managerPhone) {
    text(`${labels.sheetManager}: ${[managerName, managerPhone].filter(Boolean).join(' · ')}`, MARGIN, 10, { color: grey, maxW: CONTENT_W });
    y -= 16;
  }
  y -= 14;
  page.drawLine({ start: { x: PAGE_W - MARGIN - 180, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.7, color: grey });
  y -= 12;
  text(labels.sheetSignature, PAGE_W - MARGIN, 9, { color: grey, align: 'right' });
  y -= 22;
  page.drawLine({ start: { x: MARGIN, y: y + 14 }, end: { x: PAGE_W - MARGIN, y: y + 14 }, thickness: 0.7, color: line });
  text(footer, MARGIN, 9, { color: grey, maxW: CONTENT_W });

  // ---- page numbers, only when there is more than one --------------
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const t = `${labels.sheetPage} ${i + 1}/${pages.length}`;
      const w = font.widthOfTextAtSize(t, 8);
      p.drawText(t, { x: PAGE_W - MARGIN - w, y: MARGIN / 2, size: 8, font, color: grey });
    });
  }

  return doc.save();
}
