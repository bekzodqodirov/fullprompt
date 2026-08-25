import { clientLabels, type ClientLocale } from '@/modules/platform/telegram/client-labels';
import type { CalcSectionName } from './pricing';

/**
 * The client-facing price offer (docs/VED.md phase C), as text. Pure.
 *
 * Three rules decide everything in this file, and each was a finding against
 * the first design.
 *
 * **1. The number is the SELLER's price, not the sealed one.** A sealed
 * `calc_versions` row is what the calculation COST; the owner's law 4 makes
 * that the FLOOR the seller's client price sits above. An offer built from
 * the sealed total prints the company's floor to the customer and pre-empts
 * the upsale phase D exists for.
 *
 * **2. It does not decompose the price.** `sealCalc` writes `freight_usd` and
 * `freight_list_usd` from ONE value, so showing the parts hands the customer
 * our list price and lets them subtract the discount we were willing to give.
 * The offer names WHAT is included in words and gives one number.
 * (Stated to the owner as reversible: his law 5 splits rastamojka and
 * yo'lkira on the sheet HIS people read, which is a different sheet.)
 *
 * **3. No emoji, ever.** The same text is drawn into a PDF with NotoSansSC,
 * and 📦 / ✅ have glyph id 0 there — a hole in a customer's document, with no
 * error raised anywhere.
 */

export interface OfferInput {
  clientPriceUsd: number;
  volumeM3: number | null;
  weightKg: number | null;
  section: CalcSectionName;
  fromCity: string | null;
  toCity: string | null;
  validUntil: Date;
  clientName?: string | null;
}

/** dd.MM.yyyy in the office's own zone — see `offerDate`. */
export const OFFICE_TIME_ZONE = 'Asia/Tashkent';

/**
 * The validity date as the office reads it.
 *
 * `valid_until` is a timestamptz stamped at seal time, and a quote sealed
 * after 19:00 Tashkent is already the next day in UTC — so formatting it in
 * UTC prints a validity one day short, on the document the customer holds.
 */
export function offerDate(at: Date, timeZone = OFFICE_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')}`;
}

/** Money a customer reads: two decimals, thin-space thousands, no currency code games. */
export function offerMoney(usd: number): string {
  const [whole, cents] = usd.toFixed(2).split('.');
  return `$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${cents}`;
}

const num = (n: number, digits: number) => n.toFixed(digits).replace(/\.?0+$/, '');

/** What a section means to a CUSTOMER — never the internal word. */
export function offerIncludes(section: CalcSectionName, l: ReturnType<typeof clientLabels>): string {
  if (section === 'yolkira') return l.offerSecFreight;
  if (section === 'rastamojka') return l.offerSecCustoms;
  return l.offerSecAll;
}

export interface OfferLines {
  title: string;
  rows: { label: string; value: string }[];
  footer: string;
}

/**
 * The offer as label/value rows — one shape, rendered twice (Telegram text
 * and PDF), so the two can never say different things.
 */
export function offerLines(input: OfferInput, locale: ClientLocale): OfferLines {
  const l = clientLabels(locale);
  const rows: { label: string; value: string }[] = [];

  if (input.fromCity || input.toCity) {
    rows.push({
      label: l.offerRoute,
      value: [input.fromCity, input.toCity].filter(Boolean).join(' - '),
    });
  }
  if (input.volumeM3 !== null && input.volumeM3 > 0) {
    rows.push({ label: l.offerVolume, value: `${num(input.volumeM3, 3)} m3` });
  }
  if (input.weightKg !== null && input.weightKg > 0) {
    rows.push({ label: l.offerWeight, value: `${num(input.weightKg, 1)} kg` });
  }
  rows.push({ label: l.offerIncludes, value: offerIncludes(input.section, l) });
  rows.push({ label: l.offerTotal, value: offerMoney(input.clientPriceUsd) });

  // Per-unit lines are derived from the CLIENT price, never from the sealed
  // one — otherwise the two numbers on the sheet disagree the moment a seller
  // quotes above the floor, which is the normal case.
  if (input.volumeM3 !== null && input.volumeM3 > 0) {
    rows.push({
      label: l.offerPerM3,
      value: offerMoney(input.clientPriceUsd / input.volumeM3),
    });
  }
  if (input.weightKg !== null && input.weightKg > 0) {
    rows.push({
      label: l.offerPerKg,
      value: offerMoney(input.clientPriceUsd / input.weightKg),
    });
  }
  rows.push({ label: l.offerValidUntil, value: offerDate(input.validUntil) });

  return { title: l.offerTitle, rows, footer: l.offerFooter };
}

/** The Telegram/copy version: the same rows, as plain text. */
export function offerText(input: OfferInput, locale: ClientLocale): string {
  const { title, rows, footer } = offerLines(input, locale);
  const head = input.clientName ? `${input.clientName}\n\n${title}` : title;
  const body = rows.map((r) => `${r.label}: ${r.value}`).join('\n');
  return `${head}\n\n${body}\n\n${footer}`;
}

/**
 * The language an offer goes out in.
 *
 * `clients.locale` is a copy of the customer's TELEGRAM UI language and is
 * NULL for every client in the data, so «the client's language» silently
 * resolves to Russian for everybody while the owner's customers read Uzbek.
 * The seller therefore CHOOSES, and this is only the pre-selection.
 */
export function offerLocaleFor(clientLocale: string | null | undefined): ClientLocale {
  if (clientLocale === 'uz' || clientLocale === 'ru' || clientLocale === 'en') return clientLocale;
  return 'uz';
}
