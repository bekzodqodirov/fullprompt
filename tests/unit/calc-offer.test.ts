import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  offerDate,
  offerIncludes,
  offerLines,
  offerLocaleFor,
  offerMoney,
  offerText,
  type OfferInput,
} from '@/modules/wms/calc/offer';
import { clientLabels } from '@/modules/platform/telegram/client-labels';

const base: OfferInput = {
  clientPriceUsd: 4200,
  volumeM3: 30,
  weightKg: 1500,
  section: 'podklyuch',
  fromCity: 'Yiwu',
  toCity: 'Toshkent',
  validUntil: new Date('2026-09-22T14:00:00Z'),
};

describe('what the customer reads', () => {
  it('gives ONE number and never decomposes the price', () => {
    // `sealCalc` writes freight_usd and freight_list_usd from one value, so a
    // decomposition hands the customer our list price and lets them subtract
    // the discount we were willing to give.
    const text = offerText(base, 'uz');
    expect(text).toContain('$4 200.00');
    for (const leak of ['rastamojka:', 'yo‘lkira:', 'chegirma', 'tarif', 'band']) {
      expect(text.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it('derives the per-unit lines from the CLIENT price, not the sealed one', () => {
    const { rows } = offerLines(base, 'uz');
    const perM3 = rows.find((r) => r.label === clientLabels('uz').offerPerM3);
    const perKg = rows.find((r) => r.label === clientLabels('uz').offerPerKg);
    expect(perM3?.value).toBe('$140.00'); // 4200 / 30
    expect(perKg?.value).toBe('$2.80'); // 4200 / 1500
  });

  it('names what is included in the customer’s words, per section', () => {
    const uz = clientLabels('uz');
    expect(offerIncludes('yolkira', uz)).toBe(uz.offerSecFreight);
    expect(offerIncludes('rastamojka', uz)).toBe(uz.offerSecCustoms);
    expect(offerIncludes('podklyuch', uz)).toBe(uz.offerSecAll);
  });

  it('leaves out a measure it does not have, rather than printing a zero', () => {
    const { rows } = offerLines({ ...base, weightKg: null, volumeM3: null }, 'ru');
    const labels = rows.map((r) => r.label);
    expect(labels).not.toContain(clientLabels('ru').offerPerKg);
    expect(labels).not.toContain(clientLabels('ru').offerPerM3);
    expect(labels).toContain(clientLabels('ru').offerTotal);
  });

  it('prints the validity in the OFFICE’s day, not the server’s', () => {
    // Sealed at 20:00 Tashkent is already the next day in UTC — formatting in
    // UTC prints a validity one day short on the customer's document.
    expect(offerDate(new Date('2026-09-22T15:30:00Z'))).toBe('22.09.2026');
    expect(offerDate(new Date('2026-09-22T19:30:00Z'))).toBe('23.09.2026');
    expect(offerDate(new Date('2026-09-22T19:30:00Z'), 'UTC')).toBe('22.09.2026');
  });

  it('formats money so five figures stay readable', () => {
    expect(offerMoney(4200)).toBe('$4 200.00');
    expect(offerMoney(15675.5)).toBe('$15 675.50');
    expect(offerMoney(9.9)).toBe('$9.90');
  });

  it('offers in Uzbek unless somebody chose otherwise', () => {
    // clients.locale is a copy of the customer's Telegram UI language and is
    // NULL for every client in the data — so «the client's language» would
    // resolve to Russian for everybody while his customers read Uzbek.
    expect(offerLocaleFor(null)).toBe('uz');
    expect(offerLocaleFor('zh-CN')).toBe('uz');
    expect(offerLocaleFor('ru')).toBe('ru');
  });
});

describe('the PDF can actually draw it', () => {
  /**
   * MEASURED against `src/assets/fonts/NotoSansSC-Regular.ttf`: 📦 and ✅ have
   * glyph id 0, and so does U+02BC. A hole in a customer's document, with no
   * error raised anywhere — so no offer string may contain a character the
   * font cannot draw.
   *
   * Anchored on the SOURCE of the dictionary rather than on a rendered
   * document, because the font is only loaded in the PDF path and this must
   * fail the moment somebody adds an emoji to a label.
   */
  it('no offer label carries an emoji or any astral character', () => {
    const source = readFileSync('src/modules/platform/telegram/client-labels.ts', 'utf8');
    const block = source.slice(source.indexOf('offerTitle:'), source.indexOf('} satisfies'));
    const astral = [...block].filter((ch) => (ch.codePointAt(0) ?? 0) > 0xffff);
    expect(astral, 'emoji have no glyph in the PDF font').toEqual([]);
    expect(block).not.toContain('ʼ');
  });

  it('every character an offer emits is one the three locales agree on', () => {
    for (const locale of ['uz', 'ru', 'en'] as const) {
      const text = offerText({ ...base, clientName: 'GS100' }, locale);
      const astral = [...text].filter((ch) => (ch.codePointAt(0) ?? 0) > 0xffff);
      expect(astral, `${locale} offer must be drawable`).toEqual([]);
    }
  });
});
