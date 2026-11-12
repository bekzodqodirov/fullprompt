import { describe, expect, it } from 'vitest';
import { landingItems } from '@/modules/wms/calc/intake';
import { parseLineAnswer, parseManualFacts, readGoodsLines } from '@/modules/wms/calc/intake-manual';
import { parseTableAnswer, type TableRef } from '@/modules/wms/calc/line-address';
import { packingRead, parseGoodsLine, perOneSpans, typedPacking } from '@/modules/wms/calc/units';

/**
 * docs/AI-SORAYDI.md §3.1 T4 (the reader half) and T6 (the masking and the
 * owner rule), as the review ruled them (JN-7, JN-8, JS-1, JS-2).
 *
 * A weight, a cube or a count marked as ONE package's or ONE piece's — «har
 * biri 15 kg», «15 kg/ctn», «0.12 cbm/ctn», «20 x 15 kg», «15 kg dan» beside
 * a count — was the shipment's total and the row's own figure (DIM-4, AB-1,
 * dg2-4, dg3-01): one carton's 15 kg landed under ✅ as the whole job's, over
 * the model's correct 300. Now it reaches no total and no row's column; the
 * bot's typed reader puts it on the row's packing (`from: 'typed'`) and the
 * ONE carton arithmetic multiplies (carton-math.ts — tested there; here only
 * that the readers hand it the right factors).
 *
 * Every figure below is worked by hand in the comment beside it.
 */

/** The shipment's two totals as the typed reader states them. */
const totals = (text: string) => {
  const f = parseManualFacts(text, 'podklyuch');
  return { kg: f.weightKg ?? null, m3: f.volumeM3 ?? null, ambiguous: f.ambiguous };
};
const none = { kg: null, m3: null, ambiguous: [] };

/** The one typed goods row a line gives. */
const row = (text: string) => {
  const goods = readGoodsLines(text);
  expect(goods, text).toHaveLength(1);
  return goods[0]!;
};

describe('T4 — one package’s or one piece’s figure is never the shipment’s total', () => {
  it('DIM-4: «har biri 15 kg» beside «20 karobka» states no total at all', () => {
    // Was 15 kg — one carton's weight as the job's (the real 20 × 15 = 300).
    expect(totals('Kurtka 300 dona, 20 karobka, karobka razmeri 60x40x50 sm, har biri 15 kg')).toEqual(none);
    expect(totals('Stul 20 karobka har biri 15 kg')).toEqual(none);
  });

  it('every per-package spelling the trace met: a tail, «dan» beside a count, «20 x 15 kg»', () => {
    for (const text of [
      'Stul 15 kg/ctn 20 karobka',
      'Stul 20 karobka 15 kg/karobka',
      'Stul 20 karobka 15 kg/кор',
      'Stul 20 karobka 15 kg dan',
      'Stul 15 kg dan 20 karobka',
      'Stul 20 x 15 kg',
      'Stul 20 karobka x 15 kg',
      'Stul 20 karobka, 15 kg per ctn',
      'Stul 20 мест, вес брутто на 1 место 15 кг',
      // MP-2: the forwarded supplier line — one carton's 15 kg.
      '毛重 15kg/箱',
    ]) {
      expect(totals(text).kg, text).toBeNull();
    }
  });

  it('DIM-10: a cube and a weight of one carton each — neither is a total (the real 20 × 0.12 = 2.4 m³, 20 × 15 = 300 kg)', () => {
    expect(totals('Kurtka 20 ctns 0.12 cbm/ctn 15 kg/ctn')).toEqual(none);
  });

  it('JS-1: one PIECE’s weight is no total either — «Telefon 300 dona, har biri 0.2 kg» was 0.2 kg', () => {
    expect(totals('Telefon 300 dona, har biri 0.2 kg')).toEqual(none);
  });

  it('dg3-01: the per-carton «34kg/ctn» beside the forwarder’s «507 KGS» leaves 507 the one weight stated', () => {
    // Two lines: «Stul 20 dona» is the one goods line, so the second line's figures are the shipment's.
    expect(totals('Stul 20 dona\n15 CTNS 507 KGS 5.92 CBM, 34kg/ctn')).toEqual({ ...none, kg: 507, m3: 5.92 });
    // A shipment's brutto beside a carton's labelled one: «G.W./CTN» is the carton's.
    expect(totals('Stul 20 ctns, G.W./CTN 15 kg, G.W. 300 kg')).toEqual({ ...none, kg: 300 });
  });

  it('what is NOT marked keeps every reading it had', () => {
    // JN-8 (a): «dan» before «ortiq» is «more THAN», never «each» — even beside a count.
    expect(totals('jami 500 kg dan ortiq')).toEqual({ ...none, kg: 500 });
    expect(totals('Stul 20 karobka, 500 kg dan ortiq')).toEqual({ ...none, kg: 500 });
    // «20 kg dan 30 kg gacha» is a range: «from». Two weights, so no total —
    // and never the 30 alone, which reading «20 kg dan» as one carton's gives.
    expect(totals('Stul 20 karobka, 20 kg dan 30 kg gacha').kg).toBeNull();
    // «dan» with no count on the line marks nothing.
    expect(totals('500 kg dan')).toEqual({ ...none, kg: 500 });
    // JN-8 (b): «в коробке» describing the product is no mark.
    expect(totals('Кукла в коробке 500 шт, 20 мест, 300 кг')).toEqual({ ...none, kg: 300 });
    // «1 karobka» alone is the carton count, one carton of 15 kg — the line's.
    expect(totals('Stul 1 karobka 15 kg')).toEqual({ ...none, kg: 15 });
    // A density is no total (and never was, T14): «180 gr/m2».
    expect(totals('Mato 180 gr/m2 500 kg')).toEqual({ ...none, kg: 500 });
  });

  it('«15 kg/kor» — a slash and a word no tail knows: never a total (JN-8 (e))', () => {
    expect(totals('Stul 15 kg/kor 20 karobka').kg).toBeNull();
    expect(totals('Stul 15 кг/коробке, 20 мест').kg).toBeNull();
  });

  it('the spans the totals reader sets aside are the figures’ own — number and unit', () => {
    const text = 'Stul 20 karobka, har biri 15 kg';
    // «15 kg» starts at offset 26 («Stul 20 karobka, har biri » is 4+1+2+1+7+1+1+3+1+4+1 = 26) and ends at 31.
    expect(perOneSpans(text)).toEqual([[26, 31]]);
    // On the second line the offsets are the TEXT's: «jami 507 kg⏎» is 12 characters.
    expect(perOneSpans('jami 507 kg\n20 karobka, 15 kg/ctn')).toEqual([[12 + 12, 12 + 17]]);
  });
});

describe('T4 — the typed goods row: the figure goes onto its packing, the carton arithmetic multiplies', () => {
  it('DIM-4: 20 karobka × 15 kg = 300 kg and 20 × 60×40×50 sm = 2.4 m³, both «hisoblangan»; the name is the product', () => {
    const r = row('Kurtka 300 dona, 20 karobka, karobka razmeri 60x40x50 sm, har biri 15 kg');
    expect(r).toMatchObject({ name: 'Kurtka', quantity: 300, weightKg: 300, volumeM3: 2.4 });
    // 0.6 × 0.4 × 0.5 = 0.12 m³ one carton; × 20 = 2.4.
    expect(r.packing).toMatchObject({
      from: 'typed',
      cartons: 20,
      kgPerCarton: 15,
      kgPerCartonKind: null,
      size: { l: 60, w: 40, h: 50, unit: 'cm', of: 'package' },
    });
    expect(r.derived).toMatchObject({ weightKg: '20 × 15 kg', volumeM3: '20 × 60×40×50 sm' });
  });

  it('the landed row says how each figure came to be — and carries no «og‘irlik umumiydan» copy', () => {
    const [item] = landingItems(parseManualFacts('Kurtka 300 dona, 20 karobka, karobka razmeri 60x40x50 sm, har biri 15 kg'));
    expect(item).toMatchObject({ quantity: 300, weightKg: 300, volumeM3: 2.4 });
    expect(item!.note).toBe(
      '📦 20 karobka · 60×40×50 sm · 15 kg/karobka — sotuvchi · hajm hisoblangan: 20 × 60×40×50 sm = 2.4 m³ · og‘irlik hisoblangan: 20 × 15 kg = 300 kg',
    );
  });

  it('DIM-10: «0.12 cbm/ctn 15 kg/ctn» beside «20 ctns» — 20 × 0.12 = 2.4 m³, 20 × 15 = 300 kg; no «/ctn» left in the name', () => {
    const r = row('Kurtka 20 ctns 0.12 cbm/ctn 15 kg/ctn');
    expect(r).toMatchObject({ name: 'Kurtka', weightKg: 300, volumeM3: 2.4 });
    expect(r.packing).toMatchObject({ cartons: 20, kgPerCarton: 15, m3PerCarton: 0.12 });
  });

  it('a count per carton: 20 × 24 = 480 dona; pairs per carton: 20 × 12 = 240 juft in the measure (JR-1)', () => {
    expect(row('Ручка 20 коробок по 24 шт')).toMatchObject({ name: 'Ручка', quantity: 480 });
    expect(row('Krossovka 20 karobka x 12 juft')).toMatchObject({ name: 'Krossovka', quantity: null, measureUnit: 'juft', measureQty: 240 });
    expect(row('Stul 20 karobka, har bir karobkada 24 dona')).toMatchObject({ name: 'Stul', quantity: 480 });
  });

  it('a label with its per-package tail says which weight: «G.W./CTN 15 kg» × 20 = 300 kg, brutto', () => {
    const r = row('Stul 20 ctns, G.W./CTN 15 kg');
    expect(r).toMatchObject({ name: 'Stul', weightKg: 300 });
    expect(r.packing).toMatchObject({ kgPerCarton: 15, kgPerCartonKind: 'gross' });
    expect(r.derived).toMatchObject({ weightIsGross: true });
  });

  it('a clause bound to the cartons goes on over its segment: «har biri 15 kg 0.12 kub» — both one carton’s', () => {
    // 20 × 15 = 300 kg; 20 × 0.12 = 2.4 m³.
    expect(row('Kurtka 20 karobka, har biri 15 kg 0.12 kub')).toMatchObject({ weightKg: 300, volumeM3: 2.4 });
  });

  it('WITHOUT a carton count the figure is kept on the packing and nothing is multiplied — the row asks', () => {
    const r = row('Kurtka 300 dona 15 kg/ctn');
    expect(r).toMatchObject({ name: 'Kurtka', quantity: 300, weightKg: null });
    expect(r.packing).toMatchObject({ cartons: null, kgPerCarton: 15 });
    expect(r.derived ?? null).toBeNull();
    // «Stul har birida 24 dona» — what each CONTAINER holds, with no count of containers: no pieces of the row.
    const box = row('Stul har birida 24 dona');
    expect(box).toMatchObject({ quantity: null });
    expect(box.packing).toMatchObject({ cartons: null, pcsPerCarton: 24 });
  });

  it('JN-8 (c): a bare «20 x 15 kg» sets no carton count — 15 kg is one package’s, the phrase is kept on the note', () => {
    const r = row('Stul 20 x 15 kg');
    expect(r).toMatchObject({ name: 'Stul', quantity: null, weightKg: null, note: 'sotuvchi: 20 x 15 kg' });
    expect(r.packing).toMatchObject({ cartons: null, kgPerCarton: 15 });
    // With a carton word beside A, A IS the carton count: 20 × 15 = 300 kg.
    expect(row('Stul 20 karobka x 15 kg')).toMatchObject({ weightKg: 300 });
  });

  it('a per-carton figure with two readings is asked of nobody as a total, and multiplied by nobody — kept on the note', () => {
    // «1,200» is 1.2 or 1200 (T0): one carton's either way, so no total asks it.
    expect(totals('Stul 20 karobka, har biri 1,200 kg')).toEqual(none);
    const r = row('Stul 20 karobka, har biri 1,200 kg');
    expect(r).toMatchObject({ weightKg: null, note: 'sotuvchi: har biri 1,200 kg' });
    expect(r.packing ?? null).toBeNull();
    // A space-grouped one after the mark is whole: 20 × 1 200 = 24 000 kg.
    expect(row('Stul 20 karobka har biri 1 200 kg')).toMatchObject({ weightKg: 24000 });
  });

  it('a tonne or a gram of one piece: 2000 × 0.5 kg = 1000 kg (T14 with T4)', () => {
    const r = row('Choy 2000 dona, har biri 500 gr');
    expect(r).toMatchObject({ name: 'Choy', quantity: 2000, weightKg: 1000 });
    expect(r.packing).toMatchObject({ kgPerPiece: 0.5 });
  });
});

describe('JN-7 / JS-1 — an «each» figure binds to the count it stands with', () => {
  it('only pieces on the line → ONE PIECE’s weight: 300 × 0.2 = 60 kg, never «nechta karobka?»', () => {
    const r = row('Telefon 300 dona, har biri 0.2 kg');
    expect(r).toMatchObject({ name: 'Telefon', quantity: 300, weightKg: 60 });
    expect(r.packing).toMatchObject({ cartons: null, kgPerCarton: null, kgPerPiece: 0.2 });
  });

  it('only cartons → one carton’s: 20 × 15 = 300 kg', () => {
    expect(row('Stul 20 karobka har biri 15 kg')).toMatchObject({ name: 'Stul', weightKg: 300 });
  });

  it('both counts → the nearest count BEFORE the mark: «20 karobka, har biri 15 kg» is a carton’s (300 kg, not 300 × 15 = 4500)', () => {
    const r = row('Kurtka 300 dona, 20 karobka, har biri 15 kg');
    expect(r).toMatchObject({ quantity: 300, weightKg: 300 });
    expect(r.packing).toMatchObject({ kgPerCarton: 15 });
  });

  it('…and «300 dona har biri 0.2 kg 20 karobka» is a piece’s: 300 × 0.2 = 60 kg (the cartons after it say nothing of it)', () => {
    const r = row('Telefon 300 dona har biri 0.2 kg 20 karobka');
    expect(r).toMatchObject({ quantity: 300, weightKg: 60 });
    expect(r.packing).toMatchObject({ cartons: 20, kgPerPiece: 0.2, kgPerCarton: null });
  });

  it('a noun after the mark decides: «har bir dona 2 kg» beside 20 cartons is a piece’s — 100 × 2 = 200 kg', () => {
    expect(row('Stul 100 dona 20 karobka, har bir dona 2 kg')).toMatchObject({ quantity: 100, weightKg: 200 });
  });

  it('both counts and neither before the mark: nothing multiplied, the figure kept on the note, the weight asked', () => {
    const r = row('Stul har biri 2 kg, 100 dona, 20 karobka');
    expect(r).toMatchObject({ name: 'Stul', quantity: 100, weightKg: null, note: 'sotuvchi: har biri 2 kg' });
    expect(r.packing ?? null).toBeNull();
  });

  it('a piece’s clause ends at its figure: «300 dona har biri 0.2 kg 5 kub» — the 5 kub is the line’s own', () => {
    expect(row('Telefon 300 dona har biri 0.2 kg 5 kub')).toMatchObject({ weightKg: 60, volumeM3: 5 });
  });

  it('«har biri 300 dona» beside no carton count is each PRODUCT’s count, as it always was', () => {
    expect(row('Kurtka va shim, har biri 300 dona')).toMatchObject({ quantity: 300 });
  });

  it('«1 karobka 15 kg» is a mark only beside ANOTHER carton count: 20 × 15 = 300 kg; alone, one carton of 15 kg', () => {
    expect(row('Stul 20 karobka, 1 karobka 15 kg')).toMatchObject({ weightKg: 300 });
    expect(row('Stul 20 karobka, bitta karobkasi 15 kg')).toMatchObject({ weightKg: 300 });
    const one = row('Stul 1 karobka 15 kg');
    expect(one).toMatchObject({ weightKg: 15 });
    expect(one.packing ?? null).toBeNull();
  });
});

describe('JN-8 — «dan», «в коробке», a slash word no tail knows', () => {
  it('«dan» beside a count is «each» — before or after it: 20 × 15 = 300 kg', () => {
    expect(row('Stul 15 kg dan 20 karobka')).toMatchObject({ weightKg: 300 });
    expect(row('Stul 20 karobka 15 kg dan')).toMatchObject({ weightKg: 300 });
  });

  it('«Кукла в коробке 500 шт, 20 мест» — the doll in its box: 500 pieces, not 500 a carton', () => {
    const r = row('Кукла в коробке 500 шт, 20 мест');
    expect(r).toMatchObject({ name: 'Кукла в коробке', quantity: 500 });
    expect(r.packing ?? null).toBeNull();
  });

  it('a rate stays in the NAME as written, and is no figure of the row: «Mato 180 gr/m2 500 kg»', () => {
    expect(row('Mato 180 gr/m2 500 kg')).toMatchObject({ name: 'Mato 180 gr/m2', weightKg: 500 });
  });
});

describe('T6 — a size is the PACKAGE’s only by the owner rule (JS-2), and the package’s alone is multiplied', () => {
  it('a size right beside the carton count: 10 × (1.2 × 0.8 × 0.75 = 0.72) = 7.2 m³; size first or count first', () => {
    expect(row('Stol 10 karobka 120x80x75 sm')).toMatchObject({ name: 'Stol', volumeM3: 7.2 });
    // 20 × 0.12 = 2.4 m³.
    expect(row('stul 60x40x50 sm 20 karobka')).toMatchObject({ name: 'stul', volumeM3: 2.4 });
    expect(row('stul 60x40x50 sm 20 ta karobka')).toMatchObject({ volumeM3: 2.4 });
  });

  it('a package word naming the size: «karobka o‘lchami 60x40x50 sm» — 20 × 0.12 = 2.4 m³', () => {
    expect(row('Kurtka 300 dona, 20 karobka, karobka o‘lchami 60x40x50 sm')).toMatchObject({ name: 'Kurtka', volumeM3: 2.4 });
    expect(row('Kurtka 20 karobka, carton size 60x40x50 cm')).toMatchObject({ volumeM3: 2.4 });
  });

  it('a size right after the NAME and before any count is nobody’s said — kept, never multiplied (JS-2’s «Stol 120x80x75, 10 karobka»)', () => {
    const r = row('Stol 120x80x75 sm, 10 karobka');
    expect(r).toMatchObject({ name: 'Stol', volumeM3: null });
    expect(r.packing).toMatchObject({ cartons: 10, size: { l: 120, w: 80, h: 75, unit: 'cm', of: null } });
    // A size word that names nobody's size: the owner is asked too.
    expect(row('Kurtka 20 karobka, o‘lchami 60x40x50 sm').packing).toMatchObject({ size: { of: null } });
  });

  it('a piece’s each-size is the PRODUCT’s own: nothing multiplied by the cartons', () => {
    const r = row('Stol 10 dona 2 karobka, har bir dona 120x80x75 sm');
    expect(r).toMatchObject({ name: 'Stol', quantity: 10, volumeM3: null });
    expect(r.packing).toMatchObject({ cartons: 2, size: { of: 'product' } });
  });

  it('an each-clause bound to the cartons: «har biri 60x40x50 sm 15 kg» — 2.4 m³ and 300 kg', () => {
    expect(row('Kurtka 20 karobka, har biri 60x40x50 sm 15 kg')).toMatchObject({ weightKg: 300, volumeM3: 2.4 });
  });

  it('with no carton count a size stays in the NAME, as it always did — «Stol 120x80x100 sm 5 dona»', () => {
    const r = row('Stol 120x80x100 sm 5 dona');
    expect(r).toMatchObject({ name: 'Stol 120x80x100 sm', quantity: 5, volumeM3: null });
    expect(r.packing ?? null).toBeNull();
  });

  it('two sizes, or a tile’s two sides: nothing is taken, the name keeps them', () => {
    expect(row('Stol 120x80x75 sm 60x40x50 sm 10 karobka')).toMatchObject({ name: 'Stol 120x80x75 sm 60x40x50 sm', volumeM3: null });
    expect(row('Kafel 600x600 120 m2 10 karobka')).toMatchObject({ name: 'Kafel 600x600', measureQty: 120 });
  });

  it('a carton count alone still names nothing a table can price (c0649 — no row)', () => {
    expect(readGoodsLines('Kurtka 45 karobka')).toEqual([]);
  });

  it('a forwarder’s label and a size is no product: «Dims 60x40x50 cm 300 kg»', () => {
    expect(readGoodsLines('Dims 60x40x50 cm 300 kg')).toEqual([]);
  });
});

describe('T6 — a dimension is never a count: the size is masked in every amount reader', () => {
  const table: TableRef = {
    rows: [
      { no: 1, index: 0, seq: null, name: 'Kurtka', needs: ['dona', 'kg'] },
      { no: 2, index: 1, seq: null, name: 'Kafel', needs: ['m2'] },
    ],
    open: [{ line: 1 }, { line: 2 }],
    preferred: [{ line: 1 }, { line: 2 }],
    stage: 'review',
  };
  const answerOf = (text: string) => parseTableAnswer(text, table).segments.map((s) => ({ at: s.at, answer: s.answer }));

  it('DIM-3: «1: 60*40*50 15 kg» writes 15 kg and no count (was 50 dona)', () => {
    expect(answerOf('1: 60*40*50 15 kg')).toEqual([
      { at: { line: 1 }, answer: { kind: 'figures', figures: { quantity: null, weightKg: 15, volumeM3: null, measureUnit: null, measureQty: null }, code: null } },
    ]);
  });

  it('DIM-3: «2: 600*600 120 m2» writes 120 m² and no count (was 600 dona · 600120 m²)', () => {
    expect(answerOf('2: 600*600 120 m2')).toEqual([
      { at: { line: 2 }, answer: { kind: 'figures', figures: { quantity: null, weightKg: null, volumeM3: null, measureUnit: 'm2', measureQty: 120 }, code: null } },
    ]);
  });

  it('DIM-3: «1: 60*40*50 см 20 мест 15 кг» — the cartons are no count either (was 40 dona)', () => {
    const [segment] = answerOf('1: 60*40*50 см 20 мест 15 кг');
    expect(segment!.answer).toMatchObject({ kind: 'figures', figures: { quantity: null, weightKg: 15 } });
  });

  it('the totals reader: «jami 60x40x50 300 kg» is 300 kg, never 50 300', () => {
    expect(totals('jami 60x40x50 300 kg')).toEqual({ ...none, kg: 300 });
  });
});

describe('T4 — an ANSWER holding one package’s figure writes it nowhere', () => {
  it('a row answer is refused in the seller’s own words — never one carton’s 15 kg in the row’s column', () => {
    expect(parseLineAnswer('15 kg/ctn')).toEqual({ kind: 'refused', reason: 'per_one', detail: '15 kg/ctn' });
    expect(parseLineAnswer('har biri 0.2 kg')).toEqual({ kind: 'refused', reason: 'per_one', detail: 'har biri 0.2 kg' });
    expect(parseLineAnswer('20 x 15 kg')).toEqual({ kind: 'refused', reason: 'per_one', detail: '20 x 15 kg' });
    // An unmarked figure is still the row's.
    expect(parseLineAnswer('300 kg')).toMatchObject({ kind: 'figures', figures: { weightKg: 300 } });
  });

  it('a totals answer names it as one package’s, and writes no total from it', () => {
    const totalsTable: TableRef = {
      rows: [{ no: 1, index: 0, seq: null, name: 'Kurtka', needs: [] }],
      open: [{ totals: 'weightKg' }],
      preferred: [{ totals: 'weightKg' }],
      stage: 'review',
    };
    const [only] = parseTableAnswer('jami 15 kg/ctn', totalsTable).segments;
    expect(only).toMatchObject({ totals: null, refused: { reason: 'totals_unit', left: [{ why: 'per_one', text: '15 kg/ctn' }] } });
    const both = parseTableAnswer('jami 507 kg, har biri 15 kg', totalsTable).segments;
    expect(both[0]).toMatchObject({ totals: { weightKg: 507 } });
    expect(both[1]).toMatchObject({ refused: { reason: 'totals_unit', left: [{ why: 'per_one', text: 'har biri 15 kg' }] } });
  });
});

describe('the other doors read what they always read (review JR-22)', () => {
  it('the bare row kernel — the card form, the VED’s paste box — keeps «15 kg/ctn» as that line’s 15 kg and builds no packing', () => {
    const bare = parseGoodsLine('Kurtka 20 ctns 15 kg/ctn');
    expect(bare).toMatchObject({ weightKg: 15, cartons: 20 });
    expect(bare.packing).toBeUndefined();
  });

  it('the typed reader’s packing is built from `packingRead` alone — the two agree', () => {
    const text = 'Kurtka 20 ctns 0.12 cbm/ctn 15 kg/ctn';
    expect(parseGoodsLine(text, { packing: true }).packing).toEqual(typedPacking(packingRead(text)).packing);
  });
});
