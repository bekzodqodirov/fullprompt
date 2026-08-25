import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';
import { getSetting } from '../../platform/settings/service';
import { cjkSubsetFor, pdfTextCleaner } from '../labels/cjk-font';
import { clientLabels, type ClientLocale } from '../../platform/telegram/client-labels';
import { offerLines, type OfferInput } from './offer';

/**
 * The offer as a one-page A4 sheet the seller can send a customer.
 *
 * It draws `offerLines` and nothing else, so the PDF and the Telegram text
 * are the SAME rows by construction — a sheet that says one number while the
 * message says another is worse than having no sheet at all.
 *
 * The font is the label printer's subsetted NotoSansSC, for one measured
 * reason: it is the only embedded face in this codebase that carries Cyrillic
 * AND Latin AND the Uzbek apostrophe U+2018, and a client name arriving from
 * the book may be in any of the three. Every emoji has glyph id 0 in it,
 * which is why `offer.ts` forbids them rather than the renderer stripping
 * them — a hole in a customer's document raises no error anywhere.
 */
export async function buildOfferPdf(
  input: OfferInput,
  locale: ClientLocale,
): Promise<Uint8Array> {
  const raw = offerLines(input, locale);
  // The client's name reaches this from the book or from a Telegram display
  // name, so it can hold anything — and this font draws .notdef for every
  // emoji AND for all four of Uzbek Cyrillic's own letters (measured). A name
  // is cleaned before it is drawn, or the customer's sheet greets a row of
  // blanks with nothing anywhere raising an error.
  const clean = await pdfTextCleaner();
  const title = clean(raw.title);
  const footer = clean(raw.footer);
  const rows = raw.rows.map((r) => ({ label: clean(r.label), value: clean(r.value) }));
  const company = clean(String(await getSetting('company_name')));
  const clientName = input.clientName ? clean(input.clientName) : null;

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const bytes = await cjkSubsetFor([
    company,
    title,
    footer,
    clientName ?? '',
    ...rows.flatMap((r) => [r.label, r.value]),
  ]);
  const font = await doc.embedFont(bytes, { subset: false });

  const page = doc.addPage([595, 842]);
  const black = rgb(0, 0, 0);
  const grey = rgb(0.42, 0.42, 0.42);
  let y = 780;

  const line = (text: string, size = 12, x = 56, color = black) => {
    page.drawText(text, { x, y, size, font, color });
    y -= size + 8;
  };

  line(company, 18);
  y -= 4;
  line(title, 14);
  if (clientName) line(clientName, 12, 56, grey);
  y -= 8;

  // Label left, value right, one rule per row. The TOTAL is the only line
  // drawn large: a customer reads one number off this sheet, and the rest is
  // what that number covers.
  const totalLabel = clientLabels(locale).offerTotal;
  for (const row of rows) {
    const isTotal = row.label === totalLabel;
    const size = isTotal ? 15 : 11;
    page.drawText(row.label, { x: 56, y, size, font, color: isTotal ? black : grey });
    page.drawText(row.value, { x: 300, y, size, font, color: black });
    y -= isTotal ? 28 : 22;
  }

  y -= 10;
  page.drawLine({
    start: { x: 56, y: y + 14 },
    end: { x: 539, y: y + 14 },
    thickness: 0.7,
    color: grey,
  });
  line(footer, 10, 56, grey);

  return doc.save();
}
