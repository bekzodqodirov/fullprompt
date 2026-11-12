import { describe, expect, it } from 'vitest';
import { ambiguousTotalText } from '@/modules/wms/calc/intake';
import { parseLineAnswer, parseManualFacts, readGoodsLines } from '@/modules/wms/calc/intake-manual';
import {
  BLANK,
  blankNonAmounts,
  blankSizes,
  groupedReading,
  parseGoodsLine,
  withoutFirstGroup,
} from '@/modules/wms/calc/units';

/**
 * docs/AI-SORAYDI.md §3.1 T0 — a number is not welded onto its neighbour
 * (MP-1; review JN-5, JN-6, JS-24).
 *
 * «1 200 kg» is twelve hundred, so «…60x40x50 300kg» was fifty thousand three
 * hundred: a carton's height, a client code, a count or a model became the
 * thousands of the weight after it, under ✅ and over the model's 300 — a
 * ≈ $239 job priced ≈ $34 936. Every literal below is worked out by hand from
 * the rule the review ruled:
 *
 *  1. a size, a phone, a code's digits are no amounts;
 *  2. a space-grouped number is thousands, with no question, at the opening of
 *     a line or segment, after a totals or measure label, after a figure WITH
 *     its unit, after a size or a code;
 *  3. after a name word or a bare number it is asked with both readings.
 */

const totals = (text: string) => {
  const f = parseManualFacts(text);
  return { kg: f.weightKg ?? null, m3: f.volumeM3 ?? null, asked: f.ambiguous };
};
const asked = (text: string, short: number, long: number, field: 'weightKg' | 'volumeM3' = 'weightKg') => [
  { field, text, decimal: short, thousands: long },
];

describe('the shipment’s totals (parseManualFacts) — the thirty spellings of the trace', () => {
  it('a size before the weight: 300 kg, and nothing is asked (JS-24)', () => {
    // «20 karobka 60x40x50 300kg»: the carton is 60 by 40 by 50, the weight
    // 300. Before: «50 300» → 50300. Joined by x, the Cyrillic х, * or ×.
    for (const text of [
      'GS777 stul 20 karobka 60x40x50 300kg',
      'stul 20 karobka 60x40x50 300 kg',
      'stul 20 karobka 60х40х50 300кг',
      'stul 20 karobka 60*40*50 300 kg',
      'stul 20 karobka 60×40×50 300 kg',
      '60x40x50 300kg',
      '1: 60x40x50 300 kg',
    ]) {
      expect(totals(text), text).toEqual({ kg: 300, m3: null, asked: [] });
    }
    // 120.5 after the size was 50120.5.
    expect(totals('stul 60x40x50 120.5 kg')).toEqual({ kg: 120.5, m3: null, asked: [] });
  });

  it('the spellings the weld never reached read as they did', () => {
    expect(totals('stul 20 karobka 60x40x50sm 300 kg').kg).toBe(300);
    expect(totals('stul 20 karobka 60x40x50 sm 300 kg').kg).toBe(300);
    expect(totals('stul 20 karobka 60x40x50, 300 kg').kg).toBe(300);
    expect(totals('stul 20 karobka 300 kg 60x40x50').kg).toBe(300);
    expect(totals('stul 60x40x50 80 kg').kg).toBe(80);
    expect(totals('stul 60x40x50 1200 kg').kg).toBe(1200);
    expect(totals('Kurtka 300 dona 150 kg').kg).toBe(150);
    expect(totals('stul 20 ta 300 kg').kg).toBe(300);
    expect(totals('stul 20 karobka 2.4 kub 300 kg')).toEqual({ kg: 300, m3: 2.4, asked: [] });
  });

  it('the client’s code in its three spellings is no amount: «GS 777 300 kg» is 300, not 777 300', () => {
    for (const text of ['GS777 300 kg', 'GS777 300kg stul', 'GS 777 300 kg', 'GS-777 300 kg', 'gs 777 300 kg']) {
      expect(totals(text), text).toEqual({ kg: 300, m3: null, asked: [] });
    }
    expect(totals('GS777 300 kg 2 kub')).toEqual({ kg: 300, m3: 2, asked: [] });
    // Another company's prefix is that company's: «AB 777 300 kg» under «GS»
    // is a word and a bare number — asked.
    expect(parseManualFacts('AB 777 300 kg', undefined, { prefix: 'AB' }).weightKg).toBe(300);
    expect(parseManualFacts('AB 777 300 kg').ambiguous).toEqual(asked('777 300', 300, 777300));
  });

  it('after a name word or a bare number the first group may be another fact’s: asked, both readings (JN-6)', () => {
    // 20 chairs and 300 kg — or 20.3 tonnes? Nothing on the line says.
    expect(totals('stul 20 300 kg')).toEqual({ kg: null, m3: null, asked: asked('20 300', 300, 20300) });
    expect(totals('stul 50 300 kg')).toEqual({ kg: null, m3: null, asked: asked('50 300', 300, 50300) });
    // «iPhone 15» and «stul 20» are one shape.
    expect(totals('iPhone 15 128 kg')).toEqual({ kg: null, m3: null, asked: asked('15 128', 128, 15128) });
    expect(totals('Redmi 13 256 kg 3 kub')).toEqual({ kg: null, m3: 3, asked: asked('13 256', 256, 13256) });
    expect(totals('mijoz 777 300 kg')).toEqual({ kg: null, m3: null, asked: asked('777 300', 300, 777300) });
    // A size typed with spaces is three bare numbers.
    expect(totals('razmer 60 40 50 300 kg')).toEqual({ kg: null, m3: null, asked: asked('50 300', 300, 50300) });
    // The judge's two: a machine of 1 500 kg, and a count before the weight.
    expect(totals('Stanok 1 500 kg')).toEqual({ kg: null, m3: null, asked: asked('1 500', 500, 1500) });
    expect(totals('Kurtka 300 1 200 kg')).toEqual({ kg: null, m3: null, asked: asked('1 200', 200, 1200) });
    // Three groups: without the first, 200 000.
    expect(totals('Stul 1 200 000 kg').asked).toEqual(asked('1 200 000', 200000, 1200000));
    // A word glued to the figure by a dash is still a name word before it.
    expect(totals('Kurtka-1 200 kg').asked).toEqual(asked('1 200', 200, 1200));
    // A bracketed word, a unit word that counts nothing («Lunch box»): names.
    expect(totals('Kurtka (qora) 1 200 kg').asked).toEqual(asked('1 200', 200, 1200));
  });

  it('a model glued to its letters keeps its digits: «model A54 128 kg» is 128 (JN-5: the look-behind gains the letter)', () => {
    // Before: «54 128» → 54128.
    expect(totals('model A54 128 kg')).toEqual({ kg: 128, m3: null, asked: [] });
  });

  it('a grouped number where nothing can stand before it is thousands, and never asked', () => {
    for (const [text, kg] of [
      ['1 200 kg', 1200],
      ['12 500 kg', 12500],
      ['jami 1 200 kg', 1200],
      ['vazni 1 200 kg', 1200],
      ['Og‘irligi: 1 200 kg', 1200],
      ['G.W. 1 200 kg', 1200],
      ['faktik 1 200 kg', 1200],
      ['yuk 1 200 kg', 1200],
      ['taxminan 1 200 kg', 1200],
      ['Kurtka 300 dona 1 200 kg', 1200],
      ['Kurtka 300dona 1 200 kg', 1200],
      ['120 ta juft 1 200 kg', 1200],
      ['Kurtka, 1 200 kg', 1200],
      ['Kurtka - 1 200 kg', 1200],
      ['Kurtka: 1 200 kg', 1200],
      ['(GS777) 1 200 kg', 1200],
      ['jami 12 500,5 kg', 12500.5],
    ] as const) {
      expect(totals(text), text).toEqual({ kg, m3: null, asked: [] });
    }
    expect(totals('jami 1 200 kg 5 kub')).toEqual({ kg: 1200, m3: 5, asked: [] });
    // The commonest caption: the code, then the totals — ZERO questions (JS-24).
    expect(totals('GS777 1 200 kg 5 kub')).toEqual({ kg: 1200, m3: 5, asked: [] });
    // After a size too, absurd as the cube is: it is what he typed.
    expect(totals('20 karobka 60x40x50 2 400 kub')).toEqual({ kg: null, m3: 2400, asked: [] });
    // «20 300 kub» follows a figure with its unit.
    expect(totals('stul 15 kg 20 300 kub')).toEqual({ kg: 15, m3: 20300, asked: [] });
  });

  it('a unit that ENDS in a digit: «5 m3 200 kg» is 5 m³ and 200 kg, never 3 200 kg (JN-5)', () => {
    expect(totals('5 m3 200 kg')).toEqual({ kg: 200, m3: 5, asked: [] });
    expect(totals('jami 5 m3 200 kg')).toEqual({ kg: 200, m3: 5, asked: [] });
    expect(totals('2 м3 500 кг')).toEqual({ kg: 500, m3: 2, asked: [] });
    expect(totals('Kafel 120 m2 500 kg')).toEqual({ kg: 500, m3: null, asked: [] });
    expect(totals('Lak 50 sm3 100 kg')).toEqual({ kg: 100, m3: null, asked: [] });
    // …and a grouped weight after it is whole: it follows a figure with its unit.
    expect(totals('12 m3 1 200 kg')).toEqual({ kg: 1200, m3: 12, asked: [] });
    expect(totals('5 m³ 1 200 kg')).toEqual({ kg: 1200, m3: 5, asked: [] });
  });

  it('a phone, a «№», an article: their digits are their own', () => {
    // Before: 67 300 kg, 15 300 kg, 200 300 kg.
    expect(totals('Ali aka 90 123 45 67 300 kg')).toEqual({ kg: 300, m3: null, asked: [] });
    expect(totals('Ali aka +998 90 123 45 67 300 kg')).toEqual({ kg: 300, m3: null, asked: [] });
    expect(totals('Kurtka №15 300 kg')).toEqual({ kg: 300, m3: null, asked: [] });
    expect(totals('XJ-200 300 kg')).toEqual({ kg: 300, m3: null, asked: [] });
    expect(totals('Model 2024/15 300 kg')).toEqual({ kg: 300, m3: null, asked: [] });
    expect(totals('#5 300 kg')).toEqual({ kg: 300, m3: null, asked: [] });
  });

  it('the doubt is worded with both readings, in the totals’ own sentence', () => {
    const [doubt] = parseManualFacts('stul 20 300 kg').ambiguous;
    expect(ambiguousTotalText(doubt!)).toBe('«20 300 kg» — 300 mi yoki 20300 mi? Aniq yozing: «20300 kg» yoki «300 kg».');
  });

  it('an asked number answers nothing — the model, which read the same text, does not answer it either', () => {
    // `totalWeightFrom` takes `ambiguous` for «asked»: the field stays null.
    const f = parseManualFacts('stul 20 300 kg\nYiwu → Toshkent', 'podklyuch');
    expect(f.weightKg).toBeNull();
    expect(f.ambiguous).toHaveLength(1);
    expect(f.fromCity).toBe('Yiwu');
  });
});

describe('the row kernel (parseGoodsLine) — the same rule, for kg, dona, kub and juft', () => {
  const read = (text: string) => {
    const l = parseGoodsLine(text);
    return { name: l.name, dona: l.quantity, kg: l.weightKg, m3: l.volumeM3, cartons: l.cartons, problems: l.problems };
  };
  const two = (text: string, short: number, long: number) => [{ kind: 'ambiguous', text, decimal: short, thousands: long, grouped: true }];

  it('a size is no amount: «60*40*50 300 kg» is 300 kg and NO count (DIM-3 wrote 50 dona)', () => {
    // Before: the name «stul 60* *», 40 pieces and 50300 kg.
    expect(read('stul 20 karobka 60*40*50 300 kg')).toEqual({ name: 'stul 60*40*50', dona: null, kg: 300, m3: null, cartons: 20, problems: [] });
    expect(read('stul 20 karobka 60×40×50 300 kg')).toMatchObject({ name: 'stul 60×40×50', dona: null, kg: 300, cartons: 20 });
    expect(read('60*40*50 15 kg')).toEqual({ name: '60*40*50', dona: null, kg: 15, m3: null, cartons: null, problems: [] });
    expect(read('L60 W40 H50 300 kg')).toMatchObject({ name: 'L60 W40 H50', dona: null, kg: 300 });
    // A tile's two sides: 120 m², and no 600 pieces.
    const tile = parseGoodsLine('Kafel 600*600 120 m2');
    expect(tile).toMatchObject({ name: 'Kafel 600*600', quantity: null, measureUnit: 'm2', measureQty: 120, problems: [] });
  });

  it('after a name word a grouped number is asked — and the unit word is still stated', () => {
    expect(read('stul 20 300 kg')).toEqual({ name: 'stul', dona: null, kg: null, m3: null, cartons: null, problems: two('20 300', 300, 20300) });
    expect(read('iPhone 15 128 kg').problems).toEqual(two('15 128', 128, 15128));
    expect(read('Stanok 1 500 kg').problems).toEqual(two('1 500', 500, 1500));
    // Counts weld the same way: «Manga Vol 3», 200 pieces — or 3200?
    expect(read('Manga Vol 3 200 dona')).toMatchObject({ dona: null, problems: two('3 200', 200, 3200) });
    expect(read('Paypoq 1 200 juft').problems).toEqual(two('1 200', 200, 1200));
    expect(read('Kafel 1 200 kub').problems).toEqual(two('1 200', 200, 1200));
    // The bare count («nomi, soni») too.
    expect(read('Stul 20 300')).toMatchObject({ dona: null, problems: two('20 300', 300, 20300) });
    // A carton noun with no number before it is a word of the name.
    expect(read('Lunch box 1 200 dona').problems).toEqual(two('1 200', 200, 1200));
    // `unitWords` is what `statesGoods` reads: the line still states goods.
    expect(parseGoodsLine('Kurtka 1 200 dona').unitWords).toEqual(['dona']);
  });

  it('where nothing can stand before it the number is whole', () => {
    expect(read('1 200 kg')).toMatchObject({ kg: 1200, problems: [] });
    expect(read('jami 1 200 kg')).toMatchObject({ kg: 1200, problems: [] });
    expect(read('Kurtka, 1 200 kg')).toMatchObject({ name: 'Kurtka', kg: 1200, problems: [] });
    expect(read('Kurtka; 1 200; dona')).toMatchObject({ dona: 1200, problems: [] });
    expect(read('Kurtka 300 dona 1 200 kg')).toMatchObject({ dona: 300, kg: 1200, problems: [] });
    expect(read('Мест: 1 200')).toMatchObject({ cartons: 1200 });
    // After a model or a code its number is whole (JS-24).
    expect(read('Samsung A54 1 200 dona')).toMatchObject({ name: 'Samsung A54', dona: 1200, problems: [] });
    expect(read('GS777 1 200 kg')).toMatchObject({ kg: 1200, problems: [] });
  });

  it('an article’s or a «№»’s digits are no thousands — and stay in the name', () => {
    // Before: kg 200300 and the name «XJ-».
    expect(read('XJ-200 300 kg')).toEqual({ name: 'XJ-200', dona: null, kg: 300, m3: null, cartons: null, problems: [] });
    expect(read('Kurtka №15 300 kg')).toMatchObject({ name: 'Kurtka №15', kg: 300, problems: [] });
    expect(read('A-4 500 dona')).toMatchObject({ name: 'A-4', dona: 500 });
    // Only THERE: a figure glued to its name by a dash is still the figure,
    // and a code before a figure that is no three-digit group reads as it did.
    expect(read('Sumka-50 dona')).toMatchObject({ dona: 50, problems: [] });
    expect(read('Partiya YW-123 12 kub')).toMatchObject({ dona: 123, m3: 12 });
  });

  it('a phone is no amount: no «×45», no 67300 kg', () => {
    // Before: the row «Ali aka 90 123» × 45 with 67300 kg.
    expect(read('Ali aka 90 123 45 67 300 kg')).toEqual({ name: 'Ali aka 90 123 45 67', dona: null, kg: 300, m3: null, cartons: null, problems: [] });
    expect(read('Tel 90 123 45 67')).toMatchObject({ dona: null, kg: null });
  });
});

describe('the typed reader keeps the row and asks its figure', () => {
  it('«Kurtka 1 200 dona 300 kg» with the model down: the row stands, its count empty', () => {
    // Dropped as «unsettled» it took the product with it — on the commonest
    // way a count over 999 is typed.
    expect(readGoodsLines('Kurtka 1 200 dona 300 kg')).toMatchObject([{ name: 'Kurtka', quantity: null, weightKg: 300 }]);
    expect(readGoodsLines('stul 20 300 kg')).toMatchObject([{ name: 'stul', quantity: null, weightKg: null }]);
    // …while «1,200 kg» — a number nobody can read — still makes no row.
    expect(readGoodsLines('Kurtka 1,200 kg')).toEqual([]);
  });

  it('a client code and a weight, a contact and a weight, name no product', () => {
    // Before: a product «GS» of 777300 kg, and «Ali aka 90 123» × 45.
    expect(readGoodsLines('GS 777 300 kg')).toEqual([]);
    expect(readGoodsLines('Ali aka 90 123 45 67 300 kg')).toEqual([]);
  });

  it('as a line answer the two readings are offered, with the unit they were written in', () => {
    expect(parseLineAnswer('stul 20 300 kg')).toEqual({ kind: 'ambiguous', decimal: 300, thousands: 20300, unit: 'kg' });
    expect(parseLineAnswer('1 200 dona')).toEqual({
      kind: 'figures',
      figures: { quantity: 1200, weightKg: null, volumeM3: null, measureUnit: null, measureQty: null },
      code: null,
    });
  });
});

describe('the rule itself (units.ts)', () => {
  it('withoutFirstGroup: the second reading of a grouped number', () => {
    expect(withoutFirstGroup('20 300')).toBe(300);
    expect(withoutFirstGroup('1 200 000')).toBe(200000);
    expect(withoutFirstGroup('1 200,5')).toBe(200.5);
    // A no-break space groups too.
    expect(withoutFirstGroup('1\u00a0200')).toBe(200);
    // One piece: one reading.
    expect(withoutFirstGroup('1200')).toBeNull();
    expect(withoutFirstGroup('12.5')).toBeNull();
  });

  it('blanking keeps every offset: the text is as long as it was', () => {
    const line = 'stul 20 karobka 60*40*50 sm 300 kg';
    const out = blankSizes(line);
    expect(out).toHaveLength(line.length);
    // The size and its unit are gone (the kernel's token may take the space
    // after the unit with it); every other character stands where it stood.
    expect(out).toMatch(new RegExp(`^stul 20 karobka ${BLANK}{11,12} ?300 kg$`, 'u'));
    expect(out.indexOf('300')).toBe(line.indexOf('300'));
    // Two sizes on one line are both blanked.
    expect(blankSizes('60x40x50 va 30x20x10')).toBe(`${BLANK.repeat(8)} va ${BLANK.repeat(8)}`);
    // A phone, and a code's digits only where they would be the thousands.
    expect(blankNonAmounts('Ali 90 123 45 67 300 kg')).toBe(`Ali ${BLANK.repeat(12)} 300 kg`);
    expect(blankNonAmounts('XJ-200 300 kg')).toBe(`XJ-${BLANK.repeat(3)} 300 kg`);
    expect(blankNonAmounts('XJ-200 kg')).toBe('XJ-200 kg');
    expect(blankNonAmounts('Sumka-50 dona')).toBe('Sumka-50 dona');
    // A code is one to four letters, or a token with a digit in it; a WORD
    // before the dash is a name, and its figure is asked instead.
    expect(blankNonAmounts('A54-200 300 kg')).toBe(`A54-${BLANK.repeat(3)} 300 kg`);
    expect(blankNonAmounts('Kurtka-200 300 kg')).toBe('Kurtka-200 300 kg');
  });

  it('groupedReading: where a grouped number is whole, and where it is asked', () => {
    const at = (line: string) => groupedReading(line, line.indexOf('1 200'));
    for (const line of ['1 200 kg', '  1 200 kg', 'jami 1 200 kg', 'Kurtka, 1 200 kg', 'Kurtka: 1 200', '- 1 200 kg', '300 dona 1 200 kg', '300dona 1 200 kg', 'GS777 1 200 kg', `${BLANK.repeat(8)} 1 200 kg`, 'G.W. 1 200', 'Вес брутто 1 200', 'soni 1 200']) {
      expect(at(line), line).toBe('thousands');
    }
    for (const line of ['Kurtka 1 200 kg', 'Kurtka 300 1 200 kg', 'box 1 200 dona', 'Manga Vol 1 200 dona', 'Magic cube 1 200 dona', 'Kurtka (qora) 1 200 kg', 'Kurtka-1 200 kg']) {
      expect(at(line), line).toBe('ask');
    }
    // The caller's own labels widen it — never the default.
    expect(groupedReading('faktik 1 200 kg', 7)).toBe('ask');
    expect(groupedReading('faktik 1 200 kg', 7, (w) => w === 'faktik')).toBe('thousands');
    // Only the last words before the number are read (a long line is not
    // re-split per figure) — and a long run of spaces opens nothing.
    const far = `Kurtka${' '.repeat(300)}1 200 kg`;
    expect(groupedReading(far, far.indexOf('1 200'))).toBe('ask');
    const long = `${'so‘z '.repeat(200)}jami 1 200 kg`;
    expect(groupedReading(long, long.indexOf('1 200'))).toBe('thousands');
    const longName = `${'so‘z '.repeat(200)}kurtka 1 200 kg`;
    expect(groupedReading(longName, longName.indexOf('1 200'))).toBe('ask');
  });
});
