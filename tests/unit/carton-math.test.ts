import { describe, expect, it } from 'vitest';
import {
  applyPacking,
  cartonFigures,
  derivedNotes,
  derivedText,
  emptyPacking,
  grossFromLines,
  judgeStated,
  packingNote,
  packingStated,
  parseSize,
  sizeCube,
  sizeText,
  wholeCartons,
  type Packing,
} from '@/modules/wms/calc/carton-math';

/**
 * docs/AI-SORAYDI.md §2.3 — the ONE home of «cartons × a per-carton figure».
 * The literals here are hand-computed: a test that asked the module for its
 * own answer would restate it (#166).
 */
const packing = (over: Partial<Packing>): Packing => ({ ...emptyPacking('typed'), ...over });

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

  it('says where the token stands, so a reader can cut it out of the line', () => {
    const text = 'Kurtka 300 dona 60x40x50 sm 20 karobka';
    const token = parseSize(text)!;
    expect(text.slice(token.start, token.end)).toBe('60x40x50 sm');
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
    expect(sizeCube({ l: 5, w: 5, h: 300, unit: null })?.assumed).toBe(true);
  });

  it('no unit outside the band: nothing is guessed', () => {
    expect(sizeCube({ l: 600, w: 400, h: 500, unit: null })).toBeNull(); // millimetres? nobody knows
    expect(sizeCube({ l: 0.6, w: 0.4, h: 0.5, unit: null })).toBeNull(); // metres? nobody knows
    expect(sizeCube({ l: 60, w: 40, h: 4, unit: null })).toBeNull();
    expect(sizeCube(null)).toBeNull();
  });

  it('prints the size with the unit it was read in', () => {
    expect(sizeText({ l: 60, w: 40, h: 50, unit: 'cm' })).toBe('60×40×50 sm');
    expect(sizeText({ l: 60, w: 40, h: 50, unit: null })).toBe('60×40×50 sm'); // assumed
    expect(sizeText({ l: 600, w: 400, h: 500, unit: null })).toBe('600×400×500'); // not assumed, no unit drawn
  });
});

describe('cartonFigures — the products, each with its arithmetic', () => {
  it('cartons × the size', () => {
    const f = cartonFigures(packing({ cartons: 20, size: { l: 60, w: 40, h: 50, unit: 'cm' } }));
    expect(f.volumeM3).toEqual({ value: 2.4, how: '20 × 60×40×50 sm' });
    expect(f.assumedCm).toBe(false);
  });

  it('cartons × a stated per-carton cube — the stated cube outranks the size', () => {
    const f = cartonFigures(packing({ cartons: 30, m3PerCarton: 0.083, size: { l: 60, w: 40, h: 50, unit: 'cm' } }));
    expect(f.volumeM3).toEqual({ value: 2.49, how: '30 × 0.083 m³' });
    // 0.083 against the size's 0.12: more than 5 % apart — both are said.
    expect(f.cubeClash).toEqual({ stated: 0.083, fromSize: 0.12 });
  });

  it('cartons × weight and × pieces', () => {
    const f = cartonFigures(packing({ cartons: 20, kgPerCarton: 15, kgPerCartonKind: 'gross', pcsPerCarton: 24 }));
    expect(f.weightKg).toEqual({ value: 300, how: '20 × 15 kg', kind: 'gross' });
    expect(f.quantity).toEqual({ value: 480, how: '20 × 24' });
  });

  it('no whole carton count — no product at all', () => {
    for (const cartons of [null, 0, -3, 2.5, 100_001]) {
      const f = cartonFigures(packing({ cartons, m3PerCarton: 0.12, kgPerCarton: 15, pcsPerCarton: 24 }));
      expect(f).toEqual({ volumeM3: null, weightKg: null, quantity: null, assumedCm: false, cubeClash: null });
    }
    expect(wholeCartons(20)).toBe(20);
    expect(wholeCartons(20.5)).toBeNull();
  });

  it('a size with no unit outside the band multiplies nothing', () => {
    expect(cartonFigures(packing({ cartons: 20, size: { l: 600, w: 400, h: 500, unit: null } })).volumeM3).toBeNull();
  });

  it('a float product is rounded half-up to three places', () => {
    // 3 × 0.1 = 0.30000000000000004 in floating point.
    expect(cartonFigures(packing({ cartons: 3, m3PerCarton: 0.1 })).volumeM3?.value).toBe(0.3);
    expect(cartonFigures(packing({ cartons: 7, kgPerCarton: 1.2345 })).weightKg?.value).toBe(8.642); // 8.6415 → half-up
  });
});

describe('judgeStated — a stated figure against its packing', () => {
  const derived = { value: 2.4, how: '20 × 0.12 m³' };
  it('nothing stated → fill', () => expect(judgeStated(null, derived, 0.12, 20)).toBe('fill'));
  it('the same figure, within 2 % → agrees', () => {
    expect(judgeStated(2.4, derived, 0.12, 20)).toBe('agrees');
    expect(judgeStated(2.36, derived, 0.12, 20)).toBe('agrees');
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
      packing: packing({
        cartons: 20,
        size: { l: 60, w: 40, h: 50, unit: 'cm' },
        kgPerCarton: 15,
        kgPerCartonKind: 'gross',
        pcsPerCarton: 24,
      }),
    });
    expect(out.line.volumeM3).toBe(2.4);
    expect(out.line.weightKg).toBe(300);
    expect(out.line.quantity).toBe(480);
    expect(out.line.derived).toEqual({
      volumeM3: '20 × 60×40×50 sm',
      quantity: '20 × 24',
      weightKg: '20 × 15 kg',
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
    const out = applyPacking({
      quantity: 600,
      weightKg: 450.5,
      volumeM3: 2.48,
      packing: packing({ cartons: 30, m3PerCarton: 0.0827, kgPerCarton: 15.02, kgPerCartonKind: 'net', pcsPerCarton: 20 }),
    });
    expect(out.line).toMatchObject({ quantity: 600, weightKg: 450.5, volumeM3: 2.48 });
    expect(out.line.derived).toBeUndefined();
    expect(out.doubts).toEqual([]);
    expect(derivedNotes(out.line)).toEqual([]);
  });

  it('ONE carton’s cube read as the line’s is replaced by the product, the original kept (dg2-5, DIM-8)', () => {
    const out = applyPacking({ volumeM3: 0.12, packing: packing({ cartons: 20, size: { l: 60, w: 40, h: 50, unit: 'cm' } }) });
    expect(out.line.volumeM3).toBe(2.4);
    expect(out.line.derived).toEqual({ volumeM3: '20 × 60×40×50 sm', replaced: { volumeM3: 0.12 } });
    expect(derivedNotes(out.line)).toEqual(['hajm bitta karobkaniki edi (0.12): 20 × 60×40×50 sm = 2.4 m³']);
  });

  it('a figure the packing does not explain stays, and is a doubt for the table to ask', () => {
    const out = applyPacking({ volumeM3: 1.7, packing: packing({ cartons: 20, m3PerCarton: 0.12 }) });
    expect(out.line.volumeM3).toBe(1.7);
    expect(out.doubts).toEqual([{ field: 'volumeM3', stated: 1.7, derived: { value: 2.4, how: '20 × 0.12 m³' } }]);
    expect(out.line.derived).toBeUndefined();
  });

  it('a NET per-carton weight is the row’s own and lends no brutto', () => {
    const out = applyPacking({ weightKg: null, packing: packing({ cartons: 20, kgPerCarton: 14, kgPerCartonKind: 'net' }) });
    expect(out.line.weightKg).toBe(280);
    expect(out.line.derived).toEqual({ weightKg: '20 × 14 kg' });
  });

  it('a gross per-carton weight beside a stated row weight: the row keeps its netto, the brutto is kept apart', () => {
    const out = applyPacking({ weightKg: 280, packing: packing({ cartons: 20, kgPerCarton: 15, kgPerCartonKind: 'gross' }) });
    expect(out.line.weightKg).toBe(280);
    expect(out.line.derived).toEqual({ grossKg: { value: 300, how: '20 × 15 kg' } });
    // 280 kg netto under 300 kg brutto is a row, not a question.
    expect(out.doubts).toEqual([]);
  });

  it('…but a row weight ABOVE its packages’ brutto is asked, and a NET per-carton weight is judged as a twin', () => {
    const over = applyPacking({ weightKg: 340, packing: packing({ cartons: 20, kgPerCarton: 15, kgPerCartonKind: 'gross' }) });
    expect(over.doubts).toEqual([{ field: 'weightKg', stated: 340, derived: { value: 300, how: '20 × 15 kg' } }]);
    const net = applyPacking({ weightKg: 250, packing: packing({ cartons: 20, kgPerCarton: 14, kgPerCartonKind: 'net' }) });
    expect(net.doubts).toEqual([{ field: 'weightKg', stated: 250, derived: { value: 280, how: '20 × 14 kg' } }]);
  });

  it('one carton’s GROSS weight standing as the row’s is replaced, and the row says its weight is brutto', () => {
    const out = applyPacking({ weightKg: 15, packing: packing({ cartons: 20, kgPerCarton: 15, kgPerCartonKind: 'gross' }) });
    expect(out.line.weightKg).toBe(300);
    expect(out.line.derived).toEqual({
      weightKg: '20 × 15 kg',
      replaced: { weightKg: 15 },
      weightIsGross: true,
      grossKg: { value: 300, how: '20 × 15 kg' },
    });
  });

  it('centimetres assumed for the cube are marked on the line and said in its note', () => {
    const out = applyPacking({ volumeM3: null, packing: packing({ cartons: 20, size: { l: 60, w: 40, h: 50, unit: null } }) });
    expect(out.line.volumeM3).toBe(2.4);
    expect(out.line.derived).toEqual({ volumeM3: '20 × 60×40×50 sm', assumedCm: true });
    expect(derivedNotes(out.line)).toEqual(['hajm hisoblangan: 20 × 60×40×50 sm = 2.4 m³, sm deb olindi']);
    expect(derivedText(out.line.derived!.volumeM3!, true)).toBe('hisoblangan: 20 × 60×40×50 sm, sm deb olindi');
  });

  it('a line with no packing passes through untouched', () => {
    const line = { quantity: 5, weightKg: 10, volumeM3: null };
    expect(applyPacking(line)).toEqual({ line, doubts: [] });
    expect(applyPacking({ ...line, packing: emptyPacking('ai') }).line.derived).toBeUndefined();
    expect(packingStated(emptyPacking('ai'))).toBe(false);
  });

  it('a carton count alone computes nothing — the missing factor is the table’s to ask', () => {
    const out = applyPacking({ quantity: null, packing: packing({ cartons: 20 }) });
    expect(out.line.quantity).toBeNull();
    expect(out.line.derived).toBeUndefined();
  });

  it('called again with the same packing it changes nothing — the note is not said twice', () => {
    const first = applyPacking({ volumeM3: 0.12, packing: packing({ cartons: 20, size: { l: 60, w: 40, h: 50, unit: 'cm' } }) });
    const second = applyPacking(first.line);
    expect(second.line).toEqual(first.line);
    expect(second.doubts).toEqual([]);
    expect(derivedNotes(second.line)).toEqual(['hajm bitta karobkaniki edi (0.12): 20 × 60×40×50 sm = 2.4 m³']);
  });

  it('a computed figure follows its packing: «20 karobka» corrected to «25» moves the cube', () => {
    const first = applyPacking({ volumeM3: null, packing: packing({ cartons: 20, m3PerCarton: 0.12 }) });
    expect(first.line.volumeM3).toBe(2.4);
    const second = applyPacking({ ...first.line, packing: packing({ cartons: 25, m3PerCarton: 0.12 }) });
    expect(second.line.volumeM3).toBe(3);
    expect(second.line.derived).toEqual({ volumeM3: '25 × 0.12 m³' });
    expect(second.doubts).toEqual([]);
  });

  it('…and a computed figure whose packing no longer multiplies out is taken back, never left as a fact', () => {
    const first = applyPacking({ volumeM3: null, packing: packing({ cartons: 20, m3PerCarton: 0.12 }) });
    const second = applyPacking({ ...first.line, packing: packing({ cartons: null, m3PerCarton: 0.12 }) });
    expect(second.line.volumeM3).toBeNull();
    expect(second.line.derived).toBeUndefined();
  });

  it('a figure a PERSON typed over a computed one stands once its derived mark is cleared', () => {
    const first = applyPacking({ volumeM3: null, packing: packing({ cartons: 20, m3PerCarton: 0.12 }) });
    // The writer's contract: clear the field's mark, then write the figure.
    const typed = { ...first.line, volumeM3: 2.5, derived: {} };
    const out = applyPacking(typed);
    expect(out.line.volumeM3).toBe(2.5);
    expect(out.doubts).toEqual([{ field: 'volumeM3', stated: 2.5, derived: { value: 2.4, how: '20 × 0.12 m³' } }]);
  });
});

describe('one PIECE’s weight (a marketplace card, MP-11)', () => {
  it('pieces × the piece weight fills an empty row weight, and says how', () => {
    const out = applyPacking({ quantity: 200, weightKg: null, packing: packing({ kgPerPiece: 4.5 }) });
    expect(out.line.weightKg).toBe(900);
    expect(out.line.derived).toEqual({ weightKg: '200 × 4.5 kg', weightFromPieces: true });
    expect(derivedNotes(out.line)).toEqual(['og‘irlik hisoblangan: 200 × 4.5 kg = 900 kg']);
    expect(packingNote(out.line.packing)).toBe('📦 4.5 kg/dona — sotuvchi');
  });

  it('no piece count — no weight; the count answered later computes it', () => {
    const first = applyPacking({ quantity: null, weightKg: null, packing: packing({ kgPerPiece: 4.5 }) });
    expect(first.line.weightKg).toBeNull();
    const second = applyPacking({ ...first.line, quantity: 200 });
    expect(second.line.weightKg).toBe(900);
    // …and a corrected count moves the weight with it.
    const third = applyPacking({ ...second.line, quantity: 300 });
    expect(third.line.weightKg).toBe(1350);
  });

  it('pieces computed from the cartons feed the piece weight in the same pass', () => {
    const out = applyPacking({ quantity: null, weightKg: null, packing: packing({ cartons: 10, pcsPerCarton: 20, kgPerPiece: 4.5 }) });
    expect(out.line.quantity).toBe(200);
    expect(out.line.weightKg).toBe(900);
  });

  it('ONE piece’s weight standing as the row’s is replaced; a carton’s own weight outranks the piece’s', () => {
    const one = applyPacking({ quantity: 100, weightKg: 4.5, packing: packing({ kgPerPiece: 4.5 }) });
    expect(one.line.weightKg).toBe(450);
    expect(derivedNotes(one.line)).toEqual(['og‘irlik bitta donaniki edi (4.5): 100 × 4.5 kg = 450 kg']);
    const both = applyPacking({ quantity: 200, weightKg: null, packing: packing({ cartons: 10, kgPerCarton: 95, kgPerCartonKind: 'gross', kgPerPiece: 4.5 }) });
    expect(both.line.weightKg).toBe(950);
  });

  it('a stated row weight the pieces do not explain is asked', () => {
    const out = applyPacking({ quantity: 200, weightKg: 500, packing: packing({ kgPerPiece: 4.5 }) });
    expect(out.line.weightKg).toBe(500);
    expect(out.doubts).toEqual([{ field: 'weightKg', stated: 500, derived: { value: 900, how: '200 × 4.5 kg' } }]);
  });
});

describe('grossFromLines — the shipment’s brutto only when EVERY line has its own', () => {
  const gross = (value: number) => ({ derived: { grossKg: { value, how: 'x' } } });
  it('sums every line', () => expect(grossFromLines([gross(300), gross(210.5)])).toEqual({ value: 510.5, how: 'karobkalardan' }));
  it('one line without a gross product: no total', () => expect(grossFromLines([gross(300), {}])).toBeNull());
  it('no lines: no total', () => expect(grossFromLines([])).toBeNull());
});

describe('packingNote — what the VED reads beside a computed figure', () => {
  it('names every stated part and who stated it', () => {
    expect(
      packingNote({
        cartons: 20,
        pcsPerCarton: 24,
        kgPerCarton: 15,
        kgPerCartonKind: 'gross',
        m3PerCarton: null,
        size: { l: 60, w: 40, h: 50, unit: 'cm' },
        from: 'ai',
      }),
    ).toBe('📦 20 karobka · 60×40×50 sm · 15 kg/karobka (brutto) · 24 dona/karobka — AI o‘qidi');
    expect(packingNote(packing({ cartons: 12 }))).toBe('📦 12 karobka — sotuvchi');
    expect(packingNote(packing({ cartons: 12, from: 'file' }))).toBe('📦 12 karobka — fayldan');
  });
  it('nothing stated → no note', () => expect(packingNote(emptyPacking('ai'))).toBeNull());
});
