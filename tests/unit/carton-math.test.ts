import { describe, expect, it } from 'vitest';
import {
  PLAUSIBLE_DENSITY,
  applyPacking,
  cartonFigures,
  derivedNotes,
  derivedText,
  emptyPacking,
  grossFromLines,
  judgeStated,
  mergePacking,
  packingStated,
  packingWords,
  parseSize,
  productCubeOffer,
  setStated,
  sizeCube,
  sizeOwnerUnknown,
  sizeText,
  wholeCartons,
  type CartonSize,
  type Packing,
} from '@/modules/wms/calc/carton-math';
import { FREIGHT_LIGHT_BELOW } from '@/modules/wms/costing/freight-split';

/**
 * docs/AI-SORAYDI.md §2.3 — the ONE home of «cartons × a per-carton figure»,
 * with the safety rules of the review (docs/AI-SORAYDI-REVIEW.md; its ids
 * stand beside the cases they pin). The literals are hand-computed: a test
 * that asked the module for its own answer would restate it (#166).
 */
const packing = (over: Partial<Packing>, from: Packing['from'] = 'typed'): Packing => ({ ...emptyPacking(from), ...over });
/** A PACKAGE's size — the only kind the packages multiply. */
const box = (l: number, w: number, h: number, unit: CartonSize['unit'] = 'cm'): CartonSize => ({ l, w, h, unit, of: 'package' });

describe('parseSize — a size is read before any amount is', () => {
  it.each([
    ['60x40x50 sm', [60, 40, 50], 'cm'],
    ['60*40*50см', [60, 40, 50], 'cm'],
    ['60 x 40 x 50', [60, 40, 50], null],
    ['60×40×50 cm', [60, 40, 50], 'cm'],
    ['60х40х50 см', [60, 40, 50], 'cm'], // the Cyrillic «х»
    ['600*400*500mm', [600, 400, 500], 'mm'],
    ['0.6×0.4×0.5 m', [0.6, 0.4, 0.5], 'm'],
    ['0,6 x 0,4 x 0,5 м', [0.6, 0.4, 0.5], 'm'],
    ['60cm x 40cm x 50cm', [60, 40, 50], 'cm'],
    ['L60 W40 H50 cm', [60, 40, 50], 'cm'],
    ['Д60 Ш40 В50', [60, 40, 50], null],
  ])('«%s»', (text, sides, unit) => {
    const token = parseSize(text);
    expect(token?.sides).toEqual(sides);
    expect(token?.unit).toBe(unit);
    expect(token?.size).toEqual({ l: sides[0], w: sides[1], h: sides[2], unit });
  });

  // JN-1: a Chinese carton prints its unit in capitals, in brackets, or in
  // Han — read as «no unit» it was assumed centimetres: 100 cartons of
  // «120*80*60MM» came out 57.6 m³ instead of 0.0576.
  it.each([
    ['120*80*60MM', 'mm'],
    ['120х80х60ММ', 'mm'],
    ['60*40*50CM', 'cm'],
    ['60х40х50 СМ', 'cm'],
    ['L60 W40 H50 CM', 'cm'],
    ['60*40*50(cm)', 'cm'],
    ['60*40*50 (CM)', 'cm'],
    ['60*40*50厘米', 'cm'],
    ['60*40*50公分', 'cm'],
    ['600*400*500毫米', 'mm'],
    ['0.6*0.4*0.5米', 'm'],
    ['60x40x50 santimetr', 'cm'],
    ['60x40x50 сантиметров', 'cm'],
    // A unit glued to EACH side, in capitals — the one form the trailing-unit reader never sees.
    ['60CM x 40CM x 50CM', 'cm'],
    ['600MM*400MM*500MM', 'mm'],
  ])('the unit as a carton prints it: «%s» → %s', (text, unit) => {
    const token = parseSize(text);
    expect(token?.unit).toBe(unit);
    expect(text.slice(token!.start, token!.end)).toBe(text);
  });

  it.each(['23.6x15.7x19.7 inch', '24x16x20 in', '24x16x20"', '60x40x50 ft', '60х40х50 дюймов', '6x4x5 dm', '24*16*20英寸'])(
    'a unit this file does not convert is «other» — never centimetres: «%s»',
    (text) => {
      const token = parseSize(text);
      expect(token?.unit).toBe('other');
      expect(sizeCube(token!.size)).toBeNull();
      expect(text.slice(token!.start, token!.end)).toBe(text);
    },
  );

  it('a word after the size that is no length unit leaves the unit unsaid (and is not swallowed)', () => {
    const text = '60x40x50 karobka 20 ta';
    const token = parseSize(text)!;
    expect(token.unit).toBeNull();
    expect(text.slice(token.start, token.end)).toBe('60x40x50');
    // «м» opening another word is not metres; «m3» is not a length.
    expect(parseSize('60x40x50 мест 20')?.unit).toBeNull();
    expect(parseSize('60x40x50 m3')?.unit).toBeNull();
  });

  it('FOUR joined numbers are no size: the span is still taken out of the amounts, nothing is multiplied', () => {
    const text = 'Stul 20x60x40x50 300 kg';
    const token = parseSize(text)!;
    expect(token.sides).toEqual([20, 60, 40, 50]);
    expect(token.size).toBeNull();
    expect(text.slice(token.start, token.end)).toBe('20x60x40x50');
  });

  it('says where the token stands, so a reader can cut it out of the line', () => {
    const text = 'Kurtka 300 dona 60x40x50 sm 20 karobka';
    const token = parseSize(text)!;
    expect(text.slice(token.start, token.end)).toBe('60x40x50 sm');
    // The weld of MP-1: the size's last side must not stay beside «300kg».
    const caption = 'GS777 stul 20 karobka 60x40x50 300kg';
    const cut = parseSize(caption)!;
    expect(caption.slice(0, cut.start) + caption.slice(cut.end)).toBe('GS777 stul 20 karobka  300kg');
  });

  it('two sides are a sheet: returned, never a cube', () => {
    const token = parseSize('Kafel 600x600 mm 120 m2');
    expect(token?.sides).toEqual([600, 600]);
    expect(token?.size).toBeNull();
    // …and with no unit at all, when no word follows («1: 600*600 120 m2» wrote 600 dona).
    expect(parseSize('1: 600*600 120 m2')?.sides).toEqual([600, 600]);
  });

  it('a count times a per-package figure is NOT a size', () => {
    expect(parseSize('20 x 15 kg')).toBeNull();
    expect(parseSize('20x24 dona')).toBeNull();
    expect(parseSize('20 * 12 juft')).toBeNull();
  });

  it('a slash is no joiner, a number glued to a word is no side', () => {
    expect(parseSize('3000pcs/15ctns/507kgs')).toBeNull();
    expect(parseSize('60/40/50')).toBeNull();
    expect(parseSize('iPhone15x2x3')).toBeNull();
    expect(parseSize('2026-11-12')).toBeNull();
  });
});

describe('sizeCube — the unit written, or centimetres inside the band', () => {
  it('a written unit is used as it is', () => {
    expect(sizeCube({ l: 60, w: 40, h: 50, unit: 'cm' })).toEqual({ m3: expect.closeTo(0.12, 10), unit: 'cm', assumed: false });
    expect(sizeCube({ l: 600, w: 400, h: 500, unit: 'mm' })?.m3).toBeCloseTo(0.12, 10);
    expect(sizeCube({ l: 0.6, w: 0.4, h: 0.5, unit: 'm' })?.m3).toBeCloseTo(0.12, 10);
  });

  it('no unit: centimetres are assumed while every side is 5…300, and it says so', () => {
    expect(sizeCube({ l: 60, w: 40, h: 50, unit: null })).toEqual({ m3: expect.closeTo(0.12, 10), unit: 'cm', assumed: true });
    expect(sizeCube({ l: 5, w: 300, h: 100, unit: null })?.assumed).toBe(true);
  });

  it('no unit outside the band, or a unit it cannot convert: nothing is guessed', () => {
    expect(sizeCube({ l: 600, w: 400, h: 500, unit: null })).toBeNull();
    expect(sizeCube({ l: 0.6, w: 0.4, h: 0.5, unit: null })).toBeNull();
    expect(sizeCube({ l: 4, w: 40, h: 50, unit: null })).toBeNull();
    expect(sizeCube({ l: 24, w: 16, h: 20, unit: 'other' })).toBeNull();
    expect(sizeCube(null)).toBeNull();
  });

  it('prints the size with the unit it was read in', () => {
    expect(sizeText({ l: 60, w: 40, h: 50, unit: 'cm' })).toBe('60×40×50 sm');
    expect(sizeText({ l: 600, w: 400, h: 500, unit: 'mm' })).toBe('600×400×500 mm');
    expect(sizeText({ l: 60, w: 40, h: 50, unit: null })).toBe('60×40×50 sm');
    expect(sizeText({ l: 600, w: 400, h: 500, unit: null })).toBe('600×400×500');
    expect(sizeText({ l: 24, w: 16, h: 20, unit: 'other' })).toBe('24×16×20');
  });
});

describe('cartonFigures — the products, each with its arithmetic', () => {
  it('cartons × the size', () => {
    const f = cartonFigures(packing({ cartons: 20, size: box(60, 40, 50) }));
    expect(f.volumeM3).toEqual({ value: 2.4, how: '20 × 60×40×50 sm' });
    expect(f.cubeOne).toBeCloseTo(0.12, 10);
    expect(f.assumedCm).toBe(false);
  });

  it('cartons × a stated per-carton cube; a size that agrees with it changes nothing', () => {
    expect(cartonFigures(packing({ cartons: 30, m3PerCarton: 0.083 })).volumeM3).toEqual({ value: 2.49, how: '30 × 0.083 m³' });
    const both = cartonFigures(packing({ cartons: 20, m3PerCarton: 0.12, size: box(60, 40, 50) }));
    expect(both.volumeM3).toEqual({ value: 2.4, how: '20 × 0.12 m³' });
    expect(both.cubeClash).toBeNull();
  });

  // JN-2: the «per-carton» key may hold the LINE's cube — the size says so.
  it('a «per-carton» cube that equals cartons × the size’s is the LINE’s: used once, never multiplied', () => {
    const f = cartonFigures(packing({ cartons: 20, m3PerCarton: 2.4, size: box(60, 40, 50) }));
    expect(f.volumeM3).toEqual({ value: 2.4, how: '20 × 60×40×50 sm' });
    expect(f.cubeIsLine).toBe(true);
    expect(f.cubeClash).toBeNull();
  });

  it('a stated per-carton cube and a size that explain nothing of each other: no product, a clash', () => {
    const f = cartonFigures(packing({ cartons: 30, m3PerCarton: 0.083, size: box(60, 40, 50) }));
    expect(f.volumeM3).toBeNull();
    expect(f.cubeClash).toEqual({ stated: 0.083, fromSize: 0.12 });
  });

  it('cartons × weight, and × what one package holds — pieces, or the row’s second measure (JR-1)', () => {
    const f = cartonFigures(packing({ cartons: 20, kgPerCarton: 15, kgPerCartonKind: 'gross', pcsPerCarton: 24 }));
    expect(f.weightKg).toEqual({ value: 300, how: '20 × 15 kg', kind: 'gross' });
    expect(f.count).toEqual({ value: 480, how: '20 × 24', unit: 'dona' });
    expect(cartonFigures(packing({ cartons: 20, pcsPerCarton: 12, perCartonUnit: 'juft' })).count).toEqual({ value: 240, how: '20 × 12', unit: 'juft' });
  });

  it('no whole carton count — no product at all', () => {
    for (const cartons of [null, 0, 2.5, -3, 100_001]) {
      const f = cartonFigures(packing({ cartons, m3PerCarton: 0.12, kgPerCarton: 15, pcsPerCarton: 24 }));
      expect([f.volumeM3, f.weightKg, f.count]).toEqual([null, null, null]);
    }
    expect(cartonFigures(null).volumeM3).toBeNull();
  });

  it('a product’s own size, and a size nobody owns, multiply nothing', () => {
    expect(cartonFigures(packing({ cartons: 10, size: { l: 120, w: 80, h: 75, unit: 'cm', of: 'product' } })).volumeM3).toBeNull();
    expect(cartonFigures(packing({ cartons: 20, size: { l: 60, w: 40, h: 50, unit: 'cm', of: null } })).volumeM3).toBeNull();
  });

  it('a package size with no unit that can be trusted gives no cube and says so', () => {
    const outside = cartonFigures(packing({ cartons: 20, size: box(600, 400, 500, null) }));
    expect([outside.volumeM3, outside.sizeUnitUnsure]).toEqual([null, true]);
    const foreign = cartonFigures(packing({ cartons: 20, size: box(24, 16, 20, 'other') }));
    expect([foreign.volumeM3, foreign.sizeUnitUnsure]).toEqual([null, true]);
  });

  // JN-25: «250x180x120» is a shoebox in millimetres; in centimetres it is
  // 5.4 m³ a carton. The band 5…300 holds both.
  it('centimetres are ASSUMED only where the package is believable', () => {
    // 5.4 m³ a package from an unsaid unit: past ASSUMED_PACKAGE_MAX_M3.
    expect(cartonFigures(packing({ cartons: 10, size: box(250, 180, 120, null) })).volumeM3).toBeNull();
    // 120×80×60 = 0.576 m³ at cm; 2 kg a carton is 3.47 kg/m³ — nothing is that light.
    const light = cartonFigures(packing({ cartons: 100, kgPerCarton: 2, size: box(120, 80, 60, null) }));
    expect([light.volumeM3, light.sizeUnitUnsure]).toEqual([null, true]);
    // …the same judged by the ROW's own weight when the packing states none: 200 kg ÷ 100 = 2 kg.
    expect(cartonFigures(packing({ cartons: 100, size: box(120, 80, 60, null) }), 200).volumeM3).toBeNull();
    // 60×40×50 at 15 kg is 125 kg/m³: an ordinary carton.
    const ok = cartonFigures(packing({ cartons: 20, kgPerCarton: 15, size: box(60, 40, 50, null) }));
    expect(ok.volumeM3).toEqual({ value: 2.4, how: '20 × 60×40×50 sm' });
    expect(ok.assumedCm).toBe(true);
    // No weight anywhere: nothing to judge by — assumed, and said.
    expect(cartonFigures(packing({ cartons: 20, size: box(60, 40, 50, null) })).assumedCm).toBe(true);
  });

  it('a WRITTEN unit is doubted only past a container: «60x40x50 м» is no carton (JN-26)', () => {
    const f = cartonFigures(packing({ cartons: 2, size: box(60, 40, 50, 'm') }));
    expect([f.volumeM3, f.sizeUnitUnsure]).toEqual([null, true]);
    // A written unit is otherwise believed, whatever the density says.
    expect(cartonFigures(packing({ cartons: 100, kgPerCarton: 2, size: box(120, 80, 60, 'cm') })).volumeM3).toEqual({
      value: 57.6,
      how: '100 × 120×80×60 sm',
    });
  });

  it('the lower bound of «cargo is this dense» is the tariff’s own «impossibly light» line — one number, two files', () => {
    expect(PLAUSIBLE_DENSITY.min).toBe(FREIGHT_LIGHT_BELOW);
  });

  it('a float product is rounded half-up to three places', () => {
    // 7 × 1.2345 = 8.6415 on paper (8.641499999999999 in binary) → 8.642.
    expect(cartonFigures(packing({ cartons: 7, m3PerCarton: 1.2345 })).volumeM3?.value).toBe(8.642);
    expect(cartonFigures(packing({ cartons: 3, kgPerCarton: 0.1 })).weightKg?.value).toBe(0.3);
  });
});

describe('judgeStated — a stated figure against its packing', () => {
  const derived = { value: 2.4, how: '20 × 0.12 m³' };
  it('nothing stated → fill', () => expect(judgeStated(null, derived, 0.12, 20)).toBe('fill'));
  it('the same figure, within 2 % → agrees', () => {
    expect(judgeStated(2.4, derived, 0.12, 20)).toBe('agrees');
    expect(judgeStated(2.44, derived, 0.12, 20)).toBe('agrees');
  });
  it('ONE carton’s figure standing as the line’s → one_carton', () => {
    expect(judgeStated(0.12, derived, 0.12, 20)).toBe('one_carton');
  });
  it('with a single carton the two are the same figure, never «one carton»', () => {
    expect(judgeStated(0.12, { value: 0.12, how: '1 × 0.12 m³' }, 0.12, 1)).toBe('agrees');
  });
  it('anything else → differs: nobody guesses', () => expect(judgeStated(1.7, derived, 0.12, 20)).toBe('differs'));
  it('no product → no verdict', () => expect(judgeStated(2.4, null, 0.12, 20)).toBeNull());
});

describe('applyPacking — the one door every reader calls', () => {
  it('fills the empty figures and says how each was made', () => {
    const out = applyPacking({
      quantity: null,
      weightKg: null,
      volumeM3: null,
      packing: packing({ cartons: 20, pcsPerCarton: 24, kgPerCarton: 15, kgPerCartonKind: 'gross', size: box(60, 40, 50) }),
    });
    // 20 × 24 = 480; 20 × 15 = 300; 20 × 0.12 = 2.4 — by hand.
    expect(out.line).toMatchObject({ quantity: 480, weightKg: 300, volumeM3: 2.4 });
    expect(out.line.derived).toEqual({
      volumeM3: '20 × 60×40×50 sm',
      quantity: '20 × 24',
      weightKg: '20 × 15 kg',
      computed: { volumeM3: 2.4, quantity: 480, weightKg: 300 },
      weightIsGross: true,
      grossKg: { value: 300, how: '20 × 15 kg' },
    });
    expect(out.doubts).toEqual([]);
    expect(derivedNotes(out.line)).toEqual([
      'hajm hisoblangan: 20 × 60×40×50 sm = 2.4 m³',
      'og‘irlik hisoblangan: 20 × 15 kg = 300 kg',
      'soni hisoblangan: 20 × 24 = 480 dona',
      'og‘irlik brutto (karobka og‘irligidan)',
    ]);
  });

  it('a stated total stands: the packing fills only what is empty', () => {
    const out = applyPacking({ quantity: 480, weightKg: 290, volumeM3: 2.42, packing: packing({ cartons: 20, pcsPerCarton: 24, kgPerCarton: 15, kgPerCartonKind: 'gross', m3PerCarton: 0.12 }) });
    expect(out.line).toMatchObject({ quantity: 480, weightKg: 290, volumeM3: 2.42 });
    // 290 is the row's netto under 300 of brutto: a row, not a question.
    expect(out.doubts).toEqual([]);
    expect(out.line.derived).toEqual({ grossKg: { value: 300, how: '20 × 15 kg' } });
  });

  it('a line with no packing passes through untouched; a carton count alone computes nothing', () => {
    const bare = { quantity: 5, weightKg: 10, volumeM3: null };
    expect(applyPacking(bare)).toEqual({ line: bare, doubts: [] });
    const out = applyPacking({ quantity: null, packing: packing({ cartons: 20 }) });
    expect(out.line.quantity).toBeNull();
    expect(out.line.derived).toBeUndefined();
  });

  it('a figure the packing does not explain stays, and is a doubt for the table to ask', () => {
    const out = applyPacking({ volumeM3: 1.7, packing: packing({ cartons: 20, m3PerCarton: 0.12 }) });
    expect(out.line.volumeM3).toBe(1.7);
    expect(out.line.derived).toBeUndefined();
    expect(out.doubts).toEqual([{ kind: 'differs', field: 'volumeM3', stated: 1.7, derived: { value: 2.4, how: '20 × 0.12 m³' } }]);
  });

  it('a product too small to be a figure is not written: the row is asked (JN-26)', () => {
    const out = applyPacking({ volumeM3: null, packing: packing({ cartons: 1, m3PerCarton: 0.0004 }) });
    expect(out.line.volumeM3).toBeNull();
    expect(out.line.derived).toBeUndefined();
  });

  it('called again with the same packing it changes nothing — the note is not said twice', () => {
    const first = applyPacking({ volumeM3: 0.12, weightKg: null, packing: packing({ cartons: 20, kgPerCarton: 15, kgPerCartonKind: 'gross', size: box(60, 40, 50) }) });
    const second = applyPacking(first.line);
    expect(second.line).toEqual(first.line);
    expect(derivedNotes(second.line)).toEqual(derivedNotes(first.line));
  });
});

describe('ONE carton’s figure standing as the line’s — replaced only where two statements say so (JN-2, JR-5)', () => {
  it('a sheet’s column or a seller’s words: replaced by the product, the original kept (dg2-5, DIM-8)', () => {
    for (const from of ['typed', 'file'] as const) {
      const out = applyPacking({ volumeM3: 0.12, packing: packing({ cartons: 20, size: box(60, 40, 50) }, from) });
      expect(out.line.volumeM3).toBe(2.4);
      expect(out.line.derived).toEqual({ volumeM3: '20 × 60×40×50 sm', computed: { volumeM3: 2.4 }, replaced: { volumeM3: 0.12 } });
      expect(out.doubts).toEqual([]);
      expect(derivedNotes(out.line)).toEqual(['hajm bitta karobkaniki edi (0.12): 20 × 60×40×50 sm = 2.4 m³']);
    }
  });

  it('the MODEL’s total against the MODEL’s own packing is a question — the stated figure stays', () => {
    // The judge's two inputs: a row total equal to the carton key of the same answer.
    const out = applyPacking({
      volumeM3: 0.12,
      weightKg: 36,
      packing: packing({ cartons: 20, m3PerCarton: 0.12, kgPerCarton: 36, kgPerCartonKind: 'net' }, 'ai'),
    });
    expect(out.line).toMatchObject({ volumeM3: 0.12, weightKg: 36 });
    expect(out.line.derived).toBeUndefined();
    expect(out.doubts).toEqual([
      { kind: 'one_or_all', field: 'volumeM3', stated: 0.12, derived: { value: 2.4, how: '20 × 0.12 m³' }, perOne: 0.12 },
      { kind: 'one_or_all', field: 'weightKg', stated: 36, derived: { value: 720, how: '20 × 36 kg' }, perOne: 36 },
    ]);
  });

  it('…and an empty figure is still filled from the model’s packing, marked as computed', () => {
    const out = applyPacking({ volumeM3: null, packing: packing({ cartons: 20, m3PerCarton: 0.12 }, 'ai') });
    expect(out.line.volumeM3).toBe(2.4);
    expect(out.line.derived).toEqual({ volumeM3: '20 × 0.12 m³', computed: { volumeM3: 2.4 } });
  });

  it('a stated per-carton cube its own size contradicts is asked, and nothing is multiplied', () => {
    const out = applyPacking({ volumeM3: null, packing: packing({ cartons: 30, m3PerCarton: 0.083, size: box(60, 40, 50) }) });
    expect(out.line.volumeM3).toBeNull();
    expect(out.doubts).toEqual([{ kind: 'cube_clash', field: 'volumeM3', stated: 0.083, derived: { value: 0.12, how: '60×40×50 sm' } }]);
  });

  it('a «per-carton» cube that is the line’s is used ONCE and said so', () => {
    const out = applyPacking({ volumeM3: null, packing: packing({ cartons: 20, m3PerCarton: 2.4, size: box(60, 40, 50) }, 'ai') });
    // Not 20 × 2.4 = 48.
    expect(out.line.volumeM3).toBe(2.4);
    expect(out.line.derived).toEqual({ volumeM3: '20 × 60×40×50 sm', computed: { volumeM3: 2.4 }, cubeIsLine: true });
    expect(derivedNotes(out.line)).toEqual(['hajm 2.4 m³ — butun qatorniki (20 × 60×40×50 sm)']);
    // …and a row that states the same total agrees with it.
    expect(applyPacking({ volumeM3: 2.4, packing: packing({ cartons: 20, m3PerCarton: 2.4, size: box(60, 40, 50) }, 'ai') }).doubts).toEqual([]);
  });
});

describe('the size’s unit and owner — asked, never guessed', () => {
  it('centimetres assumed for the cube are marked on the line and said in its note', () => {
    const out = applyPacking({ volumeM3: null, packing: packing({ cartons: 20, size: box(60, 40, 50, null) }) });
    expect(out.line.volumeM3).toBe(2.4);
    expect(out.line.derived).toEqual({ volumeM3: '20 × 60×40×50 sm', computed: { volumeM3: 2.4 }, assumedCm: true });
    expect(derivedNotes(out.line)).toEqual(['hajm hisoblangan: 20 × 60×40×50 sm = 2.4 m³, sm deb olindi']);
    expect(derivedText('20 × 60×40×50 sm', true)).toBe('hisoblangan: 20 × 60×40×50 sm, sm deb olindi');
  });

  it('a unit that cannot be trusted: no cube, one question — unless the row states its cube already', () => {
    for (const size of [box(600, 400, 500, null), box(24, 16, 20, 'other'), box(250, 180, 120, null)]) {
      const out = applyPacking({ volumeM3: null, packing: packing({ cartons: 20, size }) });
      expect(out.line.volumeM3).toBeNull();
      expect(out.doubts).toEqual([{ kind: 'size_unit', field: 'volumeM3', stated: null, derived: null }]);
    }
    expect(applyPacking({ volumeM3: 2.4, packing: packing({ cartons: 20, size: box(600, 400, 500, null) }) }).doubts).toEqual([]);
  });

  it('a product’s own size beside a carton count computes NOTHING and asks nothing', () => {
    const p = packing({ cartons: 10, size: { l: 120, w: 80, h: 75, unit: 'cm', of: 'product' } });
    const out = applyPacking({ quantity: 10, volumeM3: null, packing: p });
    expect(out.line.volumeM3).toBeNull();
    expect(out.line.derived).toBeUndefined();
    expect(out.doubts).toEqual([]);
    expect(packingWords(p)).toBe('📦 10 karobka · tovar o‘lchami 120×80×75 sm — sotuvchi');
  });

  it('an owner nobody stated is asked, never multiplied', () => {
    const p = packing({ cartons: 20, size: { l: 60, w: 40, h: 50, unit: 'cm', of: null } });
    const out = applyPacking({ volumeM3: null, packing: p });
    expect(out.line.volumeM3).toBeNull();
    expect(out.doubts).toEqual([{ kind: 'size_owner', field: 'volumeM3', stated: null, derived: null }]);
    expect(sizeOwnerUnknown(p)).toBe(true);
    // …and not asked when the per-carton cube is stated anyway, or no cartons stand beside it.
    expect(sizeOwnerUnknown({ ...p, m3PerCarton: 0.12 })).toBe(false);
    expect(sizeOwnerUnknown({ ...p, cartons: null })).toBe(false);
    expect(sizeOwnerUnknown(packing({ cartons: 20, size: box(60, 40, 50) }))).toBe(false);
  });

  it('a stated ONE-carton cube is not «explained» by a product’s size', () => {
    // 0.72 would equal the table's own cube; it is the row's stated volume and stays.
    const out = applyPacking({ volumeM3: 0.72, packing: packing({ cartons: 10, size: { l: 120, w: 80, h: 75, unit: 'cm', of: 'product' } }) });
    expect(out.line.volumeM3).toBe(0.72);
    expect(out.doubts).toEqual([]);
  });

  it('a product’s size × the row’s pieces is an OFFER with its arithmetic — never written', () => {
    const lathe = { quantity: 1, volumeM3: null, packing: packing({ size: { l: 200, w: 150, h: 180, unit: 'cm', of: 'product' } }) };
    expect(productCubeOffer(lathe)).toEqual({ value: 5.4, how: '1 × 200×150×180 sm' });
    expect(applyPacking(lathe).line.volumeM3).toBeNull();
    // No pieces, a cube already there, a package's size, an unreadable unit: no offer.
    expect(productCubeOffer({ ...lathe, quantity: null })).toBeNull();
    expect(productCubeOffer({ ...lathe, volumeM3: 5 })).toBeNull();
    expect(productCubeOffer({ quantity: 1, packing: packing({ size: box(200, 150, 180) }) })).toBeNull();
    expect(productCubeOffer({ quantity: 1, packing: packing({ size: { l: 2000, w: 1500, h: 1800, unit: null, of: 'product' } }) })).toBeNull();
  });
});

describe('the weight — netto on the row, brutto on the packages (JN-4, JN-24, JS-32)', () => {
  const gross20x15 = (from: Packing['from'] = 'typed') => packing({ cartons: 20, kgPerCarton: 15, kgPerCartonKind: 'gross' }, from);

  it('a NET per-carton weight is the row’s own and lends no brutto', () => {
    const out = applyPacking({ weightKg: null, packing: packing({ cartons: 20, kgPerCarton: 14, kgPerCartonKind: 'net' }) });
    expect(out.line.weightKg).toBe(280);
    expect(out.line.derived).toEqual({ weightKg: '20 × 14 kg', computed: { weightKg: 280 } });
    expect(grossFromLines([out.line])).toBeNull();
  });

  it('a row’s netto under its packages’ brutto is a row, not a question — while it is a believable share of it', () => {
    const out = applyPacking({ weightKg: 280, packing: gross20x15() });
    expect(out.line.weightKg).toBe(280);
    expect(out.doubts).toEqual([]);
    expect(out.line.derived).toEqual({ grossKg: { value: 300, how: '20 × 15 kg' } });
    // Exactly half still passes; under half does not.
    expect(applyPacking({ weightKg: 150, packing: gross20x15() }).doubts).toEqual([]);
  });

  it('one carton’s NET weight standing as the row’s — «N.W. 14 | G.W. 15/ctn | 20 ctns» — is asked, as one carton’s', () => {
    for (const stated of [14, 3]) {
      const out = applyPacking({ weightKg: stated, packing: gross20x15('ai') });
      expect(out.line.weightKg).toBe(stated);
      expect(out.doubts).toEqual([{ kind: 'one_or_all', field: 'weightKg', stated, derived: { value: 300, how: '20 × 15 kg' }, perOne: 15 }]);
    }
    // Far under the brutto but more than one carton's: asked plainly.
    expect(applyPacking({ weightKg: 100, packing: gross20x15() }).doubts).toEqual([
      { kind: 'differs', field: 'weightKg', stated: 100, derived: { value: 300, how: '20 × 15 kg' } },
    ]);
  });

  it('one carton’s GROSS weight standing as the row’s: replaced for a sheet or a seller, asked for the model', () => {
    const typed = applyPacking({ weightKg: 15, packing: gross20x15('typed') });
    expect(typed.line.weightKg).toBe(300);
    expect(typed.line.derived).toEqual({
      weightKg: '20 × 15 kg',
      computed: { weightKg: 300 },
      replaced: { weightKg: 15 },
      weightIsGross: true,
      grossKg: { value: 300, how: '20 × 15 kg' },
    });
    const ai = applyPacking({ weightKg: 15, packing: gross20x15('ai') });
    expect(ai.line.weightKg).toBe(15);
    expect(ai.doubts.map((d) => d.kind)).toEqual(['one_or_all']);
  });

  it('a row weight ABOVE its packages’ brutto is asked; a NET per-carton weight is judged as a twin', () => {
    expect(applyPacking({ weightKg: 320, packing: gross20x15() }).doubts).toEqual([
      { kind: 'differs', field: 'weightKg', stated: 320, derived: { value: 300, how: '20 × 15 kg' } },
    ]);
    expect(applyPacking({ weightKg: 250, packing: packing({ cartons: 20, kgPerCarton: 14, kgPerCartonKind: 'net' }) }).doubts.map((d) => d.kind)).toEqual(['differs']);
  });

  it('a GROSS row weight over its packages’ NETTO: both are right (JN-4)', () => {
    const net20x14 = packing({ cartons: 20, kgPerCarton: 14, kgPerCartonKind: 'net' });
    expect(applyPacking({ weightKg: 300, weightKind: 'gross' as const, packing: net20x14 }).doubts).toEqual([]);
    // Past a quarter over, or with the row's kind unsaid, it is a question again.
    expect(applyPacking({ weightKg: 360, weightKind: 'gross' as const, packing: net20x14 }).doubts.map((d) => d.kind)).toEqual(['differs']);
    expect(applyPacking({ weightKg: 300, packing: net20x14 }).doubts.map((d) => d.kind)).toEqual(['differs']);
  });

  it('a stated weight that IS the cartons’ gross says «brutto», like a computed one (JS-32)', () => {
    const out = applyPacking({ weightKg: 300, packing: gross20x15() });
    expect(out.line.derived).toEqual({ grossKg: { value: 300, how: '20 × 15 kg' }, weightIsGross: true });
    expect(derivedNotes(out.line)).toEqual(['og‘irlik brutto (karobka og‘irligidan)']);
    // …unless the row's own source said which weight it is.
    expect(applyPacking({ weightKg: 300, weightKind: 'net' as const, packing: gross20x15() }).line.derived).toEqual({
      grossKg: { value: 300, how: '20 × 15 kg' },
    });
  });

  it('a per-package weight of an UNSAID kind fills the row, lends no brutto, and is asked which it is (JN-24)', () => {
    const out = applyPacking({ weightKg: null, packing: packing({ cartons: 10, kgPerCarton: 14 }) });
    expect(out.line.weightKg).toBe(140);
    expect(out.line.derived).toEqual({ weightKg: '10 × 14 kg', computed: { weightKg: 140 } });
    expect(out.doubts).toEqual([{ kind: 'weight_kind', field: 'weightKg', stated: null, derived: { value: 140, how: '10 × 14 kg' }, perOne: 14 }]);
    const gross = applyPacking({ weightKg: null, packing: gross20x15() }).line;
    expect(grossFromLines([gross, out.line])).toBeNull();
  });
});

describe('what one package holds — pieces, or the row’s second measure (JR-1, JN-10)', () => {
  it('«20 karobka × 12 juft» is 240 PAIRS in the pair’s own column — never 240 pieces', () => {
    const out = applyPacking({ quantity: null, measureUnit: null, measureQty: null, packing: packing({ cartons: 20, pcsPerCarton: 12, perCartonUnit: 'juft' }) });
    expect(out.line).toMatchObject({ quantity: null, measureUnit: 'juft', measureQty: 240 });
    expect(out.line.derived).toEqual({ measureQty: '20 × 12 juft', computed: { measureQty: 240 }, measureUnitSet: true });
    expect(derivedNotes(out.line)).toEqual(['o‘lchov hisoblangan: 20 × 12 juft = 240 juft']);
    expect(packingWords(out.line.packing)).toBe('📦 20 karobka · 12 juft/karobka — sotuvchi');
    // The packing gone, the measure it made goes with it — the unit too.
    const back = applyPacking({ ...out.line, packing: null });
    expect(back.line).toMatchObject({ measureUnit: null, measureQty: null });
    expect(back.line.derived).toBeUndefined();
  });

  it('a tile’s «1.44 м²/кор» × 30: square metres may be a fraction', () => {
    const out = applyPacking({ measureUnit: null, measureQty: null, packing: packing({ cartons: 30, pcsPerCarton: 1.44, perCartonUnit: 'm2' }) });
    expect(out.line).toMatchObject({ measureUnit: 'm2', measureQty: 43.2 });
    expect(out.doubts).toEqual([]);
  });

  it('a row that already states the measure keeps it: agreeing is silence, differing is a question', () => {
    const p = packing({ cartons: 20, pcsPerCarton: 12, perCartonUnit: 'juft' });
    const same = applyPacking({ measureUnit: 'juft', measureQty: 240, packing: p });
    expect([same.line.measureQty, same.doubts, same.line.derived]).toEqual([240, [], undefined]);
    expect(applyPacking({ measureUnit: 'juft', measureQty: 200, packing: p }).doubts.map((d) => d.kind)).toEqual(['differs']);
  });

  it('a per-carton count in a unit the row holds ANOTHER of is asked, never written over it', () => {
    const out = applyPacking({ measureUnit: 'm2', measureQty: 30, packing: packing({ cartons: 20, pcsPerCarton: 12, perCartonUnit: 'juft' }) });
    expect(out.line).toMatchObject({ measureUnit: 'm2', measureQty: 30 });
    expect(out.doubts).toEqual([{ kind: 'measure_clash', field: 'measureQty', stated: 30, derived: { value: 240, how: '20 × 12' } }]);
  });

  it('cartons × pieces that is not a whole number of pieces is a question, not 37.5 dona (JN-26)', () => {
    const out = applyPacking({ quantity: null, packing: packing({ cartons: 3, pcsPerCarton: 12.5 }) });
    expect(out.line.quantity).toBeNull();
    expect(out.doubts).toEqual([{ kind: 'not_whole', field: 'quantity', stated: null, derived: { value: 37.5, how: '3 × 12.5' } }]);
  });
});

describe('a figure a PERSON stated — never filled over, replaced or doubted (JN-15, JB-1)', () => {
  const p20 = packing({ cartons: 20, size: box(60, 40, 50) });

  it('a computed figure follows its packing: «20 karobka» corrected to «25» moves the cube', () => {
    const first = applyPacking({ volumeM3: null, packing: packing({ cartons: 20, m3PerCarton: 0.12 }) });
    const second = applyPacking({ ...first.line, packing: packing({ cartons: 25, m3PerCarton: 0.12 }) });
    expect(second.line.volumeM3).toBe(3);
    expect(second.line.derived).toEqual({ volumeM3: '25 × 0.12 m³', computed: { volumeM3: 3 } });
  });

  it('a computed figure whose packing no longer multiplies out is taken back; a REPLACED original comes back', () => {
    const filled = applyPacking({ volumeM3: null, packing: p20 });
    const gone = applyPacking({ ...filled.line, packing: packing({ cartons: 20 }) });
    expect(gone.line.volumeM3).toBeNull();
    expect(gone.line.derived).toBeUndefined();
    // The row said 0.12 (one carton's); with the packing withdrawn that is what it says again.
    const replaced = applyPacking({ volumeM3: 0.12, packing: p20 });
    expect(replaced.line.volumeM3).toBe(2.4);
    const back = applyPacking({ ...replaced.line, packing: null });
    expect(back.line.volumeM3).toBe(0.12);
    expect(back.line.derived).toBeUndefined();
  });

  // The judge ran exactly this: the writers that exist (placeByName's patch,
  // a pick, an undo) set the figure and leave the old mark where it was.
  it('a figure ANY writer changed after it was computed is stated — the mark does not have to be cleared', () => {
    const computed = applyPacking({ volumeM3: null, packing: p20 }).line;
    expect(computed.volumeM3).toBe(2.4);
    const careless = { ...computed, volumeM3: 2.6 }; // the derived mark still says «computed»
    const out = applyPacking(careless);
    expect(out.line.volumeM3).toBe(2.6);
    expect(out.line.derived).toBeUndefined();
    // Nobody said a PERSON chose it, so the disagreement is still named.
    expect(out.doubts).toEqual([{ kind: 'differs', field: 'volumeM3', stated: 2.6, derived: { value: 2.4, how: '20 × 60×40×50 sm' } }]);
  });

  it('setStated: the person’s figure stands through every later pass and raises no question', () => {
    const computed = applyPacking({ volumeM3: null, packing: p20 }).line;
    const typed = setStated(computed, 'volumeM3', 2.6);
    expect(typed).toMatchObject({ volumeM3: 2.6, derived: { person: ['volumeM3'] } });
    const out = applyPacking(typed);
    expect(out.line.volumeM3).toBe(2.6);
    expect(out.doubts).toEqual([]);
    expect(out.line.derived).toEqual({ person: ['volumeM3'] });
    // A corrected carton count does not move a figure a person stated.
    expect(applyPacking({ ...out.line, packing: packing({ cartons: 25, size: box(60, 40, 50) }) }).line.volumeM3).toBe(2.6);
  });

  it('a person who answers «0.12 is the whole row’s» is not overruled again', () => {
    const asked = applyPacking({ volumeM3: 0.12, packing: packing({ cartons: 20, m3PerCarton: 0.12 }, 'ai') });
    expect(asked.doubts.map((d) => d.kind)).toEqual(['one_or_all']);
    const answered = applyPacking(setStated(asked.line, 'volumeM3', 0.12));
    expect(answered.line.volumeM3).toBe(0.12);
    expect(answered.doubts).toEqual([]);
    // …and for a seller's own packing, where the arithmetic had REPLACED it.
    const replaced = applyPacking({ volumeM3: 0.12, packing: p20 }).line;
    const insisted = applyPacking(setStated(replaced, 'volumeM3', 0.12));
    expect(insisted.line.volumeM3).toBe(0.12);
    expect(insisted.line.derived).toEqual({ person: ['volumeM3'] });
  });

  it('a person’s figure taken back (null) lets the arithmetic fill the field once more', () => {
    const typed = setStated(applyPacking({ volumeM3: null, packing: p20 }).line, 'volumeM3', 2.6);
    const cleared = setStated(typed, 'volumeM3', null);
    expect(cleared.derived).toBeUndefined();
    expect(applyPacking(cleared).line.volumeM3).toBe(2.4);
  });

  it('one field stated by a person leaves the others to the arithmetic', () => {
    const p = packing({ cartons: 20, pcsPerCarton: 24, kgPerCarton: 15, kgPerCartonKind: 'net' });
    const first = applyPacking({ quantity: null, weightKg: null, packing: p }).line;
    const out = applyPacking(setStated(first, 'weightKg', 310));
    expect(out.line).toMatchObject({ quantity: 480, weightKg: 310 });
    expect(out.line.derived).toEqual({ quantity: '20 × 24', computed: { quantity: 480 }, person: ['weightKg'] });
    expect(out.doubts).toEqual([]);
  });
});

describe('one PIECE’s weight (a marketplace card, MP-11)', () => {
  it('pieces × the piece weight fills an empty row weight, and says how', () => {
    const out = applyPacking({ quantity: 200, weightKg: null, packing: packing({ kgPerPiece: 4.5 }) });
    expect(out.line.weightKg).toBe(900);
    expect(out.line.derived).toEqual({ weightKg: '200 × 4.5 kg', computed: { weightKg: 900 }, weightFromPieces: true });
    expect(derivedNotes(out.line)).toEqual(['og‘irlik hisoblangan: 200 × 4.5 kg = 900 kg']);
    expect(packingWords(out.line.packing)).toBe('📦 4.5 kg/dona — sotuvchi');
  });

  it('no piece count — no weight; the count answered later computes it, and a corrected count moves it', () => {
    const first = applyPacking({ quantity: null, weightKg: null, packing: packing({ kgPerPiece: 4.5 }) });
    expect(first.line.weightKg).toBeNull();
    const second = applyPacking({ ...first.line, quantity: 200 });
    expect(second.line.weightKg).toBe(900);
    expect(applyPacking({ ...second.line, quantity: 300 }).line.weightKg).toBe(1350);
  });

  it('pieces computed from the cartons feed the piece weight in the same pass', () => {
    const out = applyPacking({ quantity: null, weightKg: null, packing: packing({ cartons: 10, pcsPerCarton: 20, kgPerPiece: 4.5 }) });
    expect(out.line).toMatchObject({ quantity: 200, weightKg: 900 });
  });

  it('ONE piece’s weight standing as the row’s: replaced for a seller, asked for the model; a carton’s weight outranks it', () => {
    const typed = applyPacking({ quantity: 100, weightKg: 4.5, packing: packing({ kgPerPiece: 4.5 }) });
    expect(typed.line.weightKg).toBe(450);
    expect(derivedNotes(typed.line)).toEqual(['og‘irlik bitta donaniki edi (4.5): 100 × 4.5 kg = 450 kg']);
    // The judge's input: quantity 200, weight 4.5, piece weight 4.5, all the model's.
    const ai = applyPacking({ quantity: 200, weightKg: 4.5, packing: packing({ kgPerPiece: 4.5 }, 'ai') });
    expect(ai.line.weightKg).toBe(4.5);
    expect(ai.doubts).toEqual([
      { kind: 'one_or_all', field: 'weightKg', stated: 4.5, derived: { value: 900, how: '200 × 4.5 kg' }, perOne: 4.5, perPiece: true },
    ]);
    const both = applyPacking({ quantity: 200, weightKg: null, packing: packing({ cartons: 10, kgPerCarton: 95, kgPerCartonKind: 'gross', kgPerPiece: 4.5 }) });
    expect(both.line.weightKg).toBe(950);
  });

  it('a stated row weight the pieces do not explain is asked', () => {
    const out = applyPacking({ quantity: 200, weightKg: 500, packing: packing({ kgPerPiece: 4.5 }) });
    expect(out.line.weightKg).toBe(500);
    expect(out.doubts).toEqual([{ kind: 'differs', field: 'weightKg', stated: 500, derived: { value: 900, how: '200 × 4.5 kg' } }]);
  });
});

describe('mergePacking — one row, two sources (JS-31)', () => {
  // Conversation B of the review: the caption «20 karobka 60x40x50» beside
  // the packing list's photo «20 CTNS · 2 PCS/CTN · 15 kg G.W./CTN · 60*40*50 CM».
  const typed = packing({ cartons: 20, size: box(60, 40, 50, null) }, 'typed');
  const read = packing({ cartons: 20, pcsPerCarton: 2, kgPerCarton: 15, kgPerCartonKind: 'gross', size: box(60, 40, 50, 'cm') }, 'ai');

  it('each factor from whoever states it; an unsaid unit takes the other side’s', () => {
    const { packing: merged, clashes } = mergePacking(typed, read);
    expect(clashes).toEqual([]);
    expect(merged).toMatchObject({
      cartons: 20,
      pcsPerCarton: 2,
      kgPerCarton: 15,
      kgPerCartonKind: 'gross',
      size: { l: 60, w: 40, h: 50, unit: 'cm', of: 'package' },
      fromOf: { cartons: 'typed', size: 'typed', pcsPerCarton: 'ai', kgPerCarton: 'ai' },
    });
    // 20 × 2 = 40; 20 × 0.12 = 2.4, and no «sm deb olindi»: the document says CM.
    const out = applyPacking({ quantity: null, weightKg: 300, volumeM3: null, packing: merged });
    expect(out.line).toMatchObject({ quantity: 40, weightKg: 300, volumeM3: 2.4 });
    expect(out.line.derived?.assumedCm).toBeUndefined();
    expect(out.doubts).toEqual([]);
    expect(packingWords(merged)).toBe('📦 20 karobka · 60×40×50 sm · 15 kg/karobka (brutto) · 2 dona/karobka — sotuvchi + AI o‘qidi');
  });

  it('a factor the two state DIFFERENTLY is left out and asked — never silently either', () => {
    const { packing: merged, clashes } = mergePacking(typed, { ...read, cartons: 25 });
    expect(clashes).toEqual([{ factor: 'cartons', mine: '20', theirs: '25' }]);
    expect(merged?.cartons).toBeNull();
    // Nothing is multiplied by a count nobody agrees on.
    expect(applyPacking({ volumeM3: null, weightKg: null, packing: merged }).line).toMatchObject({ volumeM3: null, weightKg: null });
    const sizes = mergePacking(typed, { ...read, size: box(80, 60, 40, 'cm') });
    expect(sizes.clashes).toEqual([{ factor: 'size', mine: '60×40×50 sm', theirs: '80×60×40 sm' }]);
    expect(sizes.packing?.size).toBeNull();
  });

  it('one side only is that side; neither is nothing', () => {
    expect(mergePacking(typed, null)).toEqual({ packing: typed, clashes: [] });
    expect(mergePacking(null, read)).toEqual({ packing: read, clashes: [] });
    expect(mergePacking(emptyPacking('typed'), emptyPacking('ai'))).toEqual({ packing: null, clashes: [] });
  });

  it('the source of a factor decides the replacement: a typed carton weight replaces, the model’s is asked', () => {
    const { packing: merged } = mergePacking(packing({ cartons: 20 }, 'typed'), packing({ kgPerCarton: 15, kgPerCartonKind: 'gross' }, 'ai'));
    expect(applyPacking({ weightKg: 15, packing: merged }).doubts.map((d) => d.kind)).toEqual(['one_or_all']);
  });
});

describe('grossFromLines — the shipment’s brutto only when EVERY line has its own', () => {
  const gross = (value: number) => ({ derived: { grossKg: { value, how: 'x' } } });
  it('sums every line', () => expect(grossFromLines([gross(300), gross(210.5)])).toEqual({ value: 510.5, how: 'karobkalardan' }));
  it('one line without a gross product: no total', () => expect(grossFromLines([gross(300), {}])).toBeNull());
  it('no lines: no total', () => expect(grossFromLines([])).toBeNull());
});

describe('packingWords — what the VED reads beside a computed figure', () => {
  it('names every stated part and who stated it', () => {
    expect(
      packingWords({
        cartons: 20,
        pcsPerCarton: 24,
        kgPerCarton: 15,
        kgPerCartonKind: 'gross',
        m3PerCarton: 0.12,
        size: box(60, 40, 50),
        from: 'ai',
      }),
    ).toBe('📦 20 karobka · 60×40×50 sm · 0.12 m³/karobka · 15 kg/karobka (brutto) · 24 dona/karobka — AI o‘qidi');
    expect(packingWords(packing({ cartons: 5 }, 'file'))).toBe('📦 5 karobka — fayldan');
    expect(packingWords(packing({ cartons: 20, size: { l: 60, w: 40, h: 50, unit: 'cm', of: null } }))).toBe(
      '📦 20 karobka · o‘lcham (kimniki — aniq emas) 60×40×50 sm — sotuvchi',
    );
  });
  it('nothing stated → no note', () => expect(packingWords(emptyPacking('ai'))).toBeNull());
});

describe('small helpers', () => {
  it('wholeCartons: whole, positive, at most 100 000', () => {
    expect([wholeCartons(20), wholeCartons(1), wholeCartons(100_000)]).toEqual([20, 1, 100_000]);
    expect([wholeCartons(0), wholeCartons(2.5), wholeCartons(-1), wholeCartons(100_001), wholeCartons(null), wholeCartons(Number.NaN)]).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });
  it('packingStated: anything at all', () => {
    expect(packingStated(emptyPacking('typed'))).toBe(false);
    expect(packingStated(packing({ cartons: 1 }))).toBe(true);
    expect(packingStated(packing({ kgPerPiece: 4.5 }))).toBe(true);
    expect(packingStated(null)).toBe(false);
  });
});
