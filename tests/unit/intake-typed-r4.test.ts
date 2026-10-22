import { describe, expect, it } from 'vitest';
import { parseClientHint } from '@/modules/wms/calc/intake';
import { figureRow, goodsEvidence, looksLikeMaterial, readGoodsLines } from '@/modules/wms/calc/intake-manual';

/**
 * Round 4 of the typed readers, where the rule reaches past the cases the
 * regression corpus (fixtures/intake-corpus.ts) pins: the corpus says what
 * each reviewer's input must read; these say what the rule built for them
 * must also keep.
 */
const GS = { prefix: 'GS' };
const names = (text: string, opts?: { labelledOnly?: boolean }) => readGoodsLines(text, opts).map((g) => g.name);

describe('a long contact line', () => {
  it('naming somebody’s relative is about another person, not the customer’s contact', () => {
    const line = 'Ali aka Toshkent Chilonzor bozori, Boburning ukasi +998 90 123 45 67';
    expect(line.length).toBeGreaterThan(60);
    expect(parseClientHint(line, GS)).toBeNull();
    // …the same contact without the relative is the customer.
    expect(parseClientHint('Ali aka Toshkent Chilonzor bozori, 15-dokon +998 90 123 45 67', GS)).toEqual({
      phone: '+998 90 123 45 67',
    });
  });
});

describe('a plural list', () => {
  it('splits on a list comma and never on a decimal one', () => {
    expect(readGoodsLines('Tovarlar: kurtka 2,5 kub, shim 3 kub')).toEqual([
      expect.objectContaining({ name: 'kurtka', volumeM3: 2.5 }),
      expect.objectContaining({ name: 'shim', volumeM3: 3 }),
    ]);
  });
});

describe('the shipment’s own words', () => {
  it('make a chat line only when nothing else names a product', () => {
    expect(names('Konteyner 68 kub')).toEqual([]);
    expect(names('Plastik konteyner 300 kg')).toEqual(['Plastik konteyner']);
    expect(names('Konteyner 500 dona')).toEqual(['Konteyner']);
    expect(names('Yuk mashina shinasi 150 kg')).toEqual(['Yuk mashina shinasi']);
  });
});

describe('a measure field under a label', () => {
  it('is the goods’ total, never a product named «hajmi»', () => {
    expect(readGoodsLines('Tovar: hajmi 3 kub')).toEqual([]);
    expect(readGoodsLines('Товар: вес 150 кг')).toEqual([]);
    expect(names('Tovar: Total 200 litr')).toEqual(['Total']);
  });
});

describe('a status under a label', () => {
  it('is read off the last word: a place in the locative only closes the body', () => {
    expect(readGoodsLines('Tovar: kurtka Toshkentga', { labelledOnly: true })).toEqual([]);
    expect(names('Tovar: Andijonda tikilgan kurtka')).toEqual(['Andijonda tikilgan kurtka']);
    expect(names('Tovar: Xitoy choyi')).toEqual(['Xitoy choyi']);
  });
});

describe('the customer question’s goods tests', () => {
  it('goodsEvidence is what looksLikeMaterial decides first', () => {
    for (const text of ['Tovar: tayyor', 'Kurtka 300 dona', 'Kurtka 6201.93.0000', 'Mahsulot: 5 kun ichida']) {
      expect(goodsEvidence(text, GS), text).toBe(true);
      expect(looksLikeMaterial(text, GS), text).toBe(true);
    }
    for (const text of ['Ali aka', 'GS777', '+998 90 123 45 67', 'Kurtka 1200 50 3000']) {
      expect(goodsEvidence(text, GS), text).toBe(false);
    }
  });

  it('figureRow is a row of figures and never a phone being typed', () => {
    expect(figureRow('Kurtka 1200 50 3000')).toBe(true);
    expect(figureRow('Kurtka 1250 50 30 12.5')).toBe(true);
    expect(figureRow('Ali aka 123 45 67')).toBe(false);
    expect(figureRow('Ali 90 123 45')).toBe(false);
  });

  it('three bare nouns in a list are goods, a name and its places a contact', () => {
    expect(looksLikeMaterial('Kurtka, shim, sharf', GS)).toBe(true);
    expect(looksLikeMaterial('Rustam, Andijon, Chilonzor', GS)).toBe(false);
    expect(looksLikeMaterial('Kurtka, shim', GS)).toBe(false);
  });
});
