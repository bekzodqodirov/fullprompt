import { describe, expect, it } from 'vitest';
import {
  KG_SCALE,
  lineIsLotGood,
  M3_SCALE,
  parseDraft,
  toCount,
  toUnits,
  type DraftLine,
} from '@/modules/wms/receipts/composition-math';
import {
  appliedName,
  applyProposal,
  buildProposal,
  cartonsMixed,
  countCell,
  draftLineOf,
  duplicateNames,
  figureText,
  hasTypedLines,
  measureCell,
  READ_MAX_ROWS,
  tickedSums,
  tickedToBegin,
  type ProposalRow,
  type ReadAnswer,
  type ReadRow,
} from '@/modules/wms/receipts/tarkib-proposal';

/**
 * «🤖 Fayldan to'ldirish» — what the model transcribed becomes the tarkib
 * editor's cells (docs/TARKIB-TAKLIFLAR.md §3). Pure, so every rule is here
 * as arithmetic and none of it needs a model:
 *
 *  · a figure the reading did not give is an EMPTY cell — never 0;
 *  · a figure is written at the column's scale exactly as `toUnits` reads it
 *    back, by decimal arithmetic and never `x * 1000`;
 *  · the kg column is ONE kind of weight for every row;
 *  · the name a row is applied under keeps the save's `tnved_would_vanish`
 *    guard able to recognise the lot's own good;
 *  · nothing is added together, scaled or made to fit.
 */

const row = (over: Partial<ReadRow> = {}): ReadRow => ({
  name: 'Клавиатура',
  name_ru: null,
  pieces: null,
  cartons: null,
  gross_kg: null,
  net_kg: null,
  volume_m3: null,
  hs_code: null,
  unsure: null,
  ...over,
});
const answer = (rows: ReadRow[], over: Partial<ReadAnswer> = {}): ReadAnswer => ({
  rows,
  totals: null,
  document: 'packing_list',
  notes: null,
  ...over,
});
const whole = { rowsCut: false, cellsCut: false };
const build = (rows: ReadRow[], over: Partial<ReadAnswer> = {}) => buildProposal(answer(rows, over), whole);

describe('a measure the reading gave → the cell at the column’s scale', () => {
  it('no figure is an empty cell and says nothing — never «0.000»', () => {
    expect(measureCell(null, KG_SCALE)).toEqual({ cell: '', note: null });
  });

  it('a formula’s binary float is read at twelve significant digits: 37.800000000000004 is 37.8', () => {
    expect(figureText(37.800000000000004)).toBe('37.8');
    expect(measureCell(37.800000000000004, KG_SCALE)).toEqual({ cell: '37.800', note: null });
    expect(measureCell(0.1 + 0.2, M3_SCALE)).toEqual({ cell: '0.3000', note: null });
    expect(measureCell(600, KG_SCALE)).toEqual({ cell: '600.000', note: null });
    expect(measureCell(2.5, M3_SCALE)).toEqual({ cell: '2.5000', note: null });
  });

  it('rounds half-up in DECIMAL — 0.5005 × 1000 is 500.49999999999994 in floating point', () => {
    // The premise: the float product rounds the wrong way.
    expect(0.5005 * 1000).toBe(500.49999999999994);
    expect(Math.round(0.5005 * 1000)).toBe(500);
    expect(measureCell(0.5005, KG_SCALE)).toEqual({ cell: '0.501', note: 'rounded' });
    expect(measureCell(1.23456, KG_SCALE)).toEqual({ cell: '1.235', note: 'rounded' });
    expect(measureCell(1.23444, KG_SCALE)).toEqual({ cell: '1.234', note: 'rounded' });
    expect(measureCell(0.12345, M3_SCALE)).toEqual({ cell: '0.1235', note: 'rounded' });
  });

  it('a figure that rounds to nothing at the column’s scale is an EMPTY cell and a note', () => {
    expect(measureCell(0.0004, KG_SCALE)).toEqual({ cell: '', note: 'dropped' });
    expect(measureCell(0.00004, M3_SCALE)).toEqual({ cell: '', note: 'dropped' });
    // …and one that rounds UP to the smallest unit is that unit, said as rounded.
    expect(measureCell(0.0005, KG_SCALE)).toEqual({ cell: '0.001', note: 'rounded' });
  });

  it('zero, a negative, a non-number and a figure past the column are dropped — never written', () => {
    for (const x of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1e9, 1e300]) {
      expect(measureCell(x, KG_SCALE), String(x)).toEqual({ cell: '', note: 'dropped' });
    }
    // numeric(12,4) holds one whole digit fewer than numeric(12,3).
    expect(measureCell(1e8, M3_SCALE)).toEqual({ cell: '', note: 'dropped' });
    expect(measureCell(99_999_999, M3_SCALE).cell).toBe('99999999.0000');
  });

  it('every cell it writes is read back by the editor’s own parser as the same figure', () => {
    for (const [x, scale] of [
      [37.800000000000004, KG_SCALE],
      [1234.5, KG_SCALE],
      [0.001, KG_SCALE],
      [12.3456, M3_SCALE],
      [0.0001, M3_SCALE],
      [999_999_999.999, KG_SCALE],
    ] as const) {
      const { cell } = measureCell(x, scale);
      expect(cell, String(x)).not.toBe('');
      expect(toUnits(cell, scale), cell).toBe(Math.round(Number(cell) * 10 ** scale));
    }
  });
});

describe('a count the reading gave → the cell', () => {
  it('whole only within a float’s noise of an integer, and within int4', () => {
    expect(countCell(null)).toEqual({ cell: '', note: null });
    expect(countCell(500)).toEqual({ cell: '500', note: null });
    // «1,000 pcs» read as one thousand.
    expect(countCell(1000)).toEqual({ cell: '1000', note: null });
    expect(countCell(500.0000000001)).toEqual({ cell: '500', note: null });
    expect(countCell(2_147_483_647)).toEqual({ cell: '2147483647', note: null });
  });

  it('a fraction, a zero and a figure past the column are EMPTY and said — 12.5 cartons is neither 12 nor 13', () => {
    for (const x of [12.5, 0.4, 0, -3, 2_147_483_648, Number.NaN]) {
      expect(countCell(x), String(x)).toEqual({ cell: '', note: 'dropped' });
    }
  });

  it('…and what it writes is a count the editor accepts', () => {
    expect(toCount(countCell(1000).cell)).toBe(1000);
  });
});

describe('the kg column carries ONE kind of weight', () => {
  it('gross, when every row states its own', () => {
    const p = build([row({ name: 'Мышь', gross_kg: 600, net_kg: 550 }), row({ name: 'Коврик', gross_kg: 400, net_kg: 380 })]);
    expect(p.weightKind).toBe('gross');
    expect(p.rows.map((r) => r.kg)).toEqual(['600.000', '400.000']);
    expect(p.rows.flatMap((r) => r.notes)).toEqual([]);
  });

  it('net for EVERY row as soon as one row has no gross — and the unused gross stays on its row as a note', () => {
    const p = build([row({ name: 'Мышь', gross_kg: 600, net_kg: 550 }), row({ name: 'Коврик', gross_kg: null, net_kg: 380 })]);
    expect(p.weightKind).toBe('net');
    expect(p.rows.map((r) => r.kg)).toEqual(['550.000', '380.000']);
    expect(p.rows[0]!.notes).toEqual([{ code: 'gross_unused', params: { value: '600.000' } }]);
    expect(p.rows[1]!.notes).toEqual([]);
  });

  it('a gross printed once for a group of rows is never spread, never written: empty cells, the figure in a note', () => {
    const p = build([row({ name: 'Мышь', gross_kg: 37.8 }), row({ name: 'Коврик' }), row({ name: 'Гарнитура' })]);
    expect(p.weightKind).toBeNull();
    expect(p.rows.map((r) => r.kg)).toEqual(['', '', '']);
    expect(p.rows[0]!.notes).toEqual([{ code: 'gross_unused', params: { value: '37.800' } }]);
  });

  it('a gross of 0 is no gross: the column falls back to net', () => {
    const p = build([row({ name: 'Мышь', gross_kg: 0, net_kg: 5 }), row({ name: 'Коврик', gross_kg: 7, net_kg: 6 })]);
    expect(p.weightKind).toBe('net');
    expect(p.rows.map((r) => r.kg)).toEqual(['5.000', '6.000']);
  });
});

describe('the supplier’s code column', () => {
  it('ten digits are a TNVED cell; a 6- or 8-digit HS code is the exporter’s — a note, an empty cell', () => {
    const p = build([
      row({ name: 'Мышь', hs_code: '8471.60.7000' }),
      row({ name: 'Коврик', hs_code: '847160' }),
      row({ name: 'Гарнитура', hs_code: '8471 6070' }),
      row({ name: 'Кабель', hs_code: 'HS: n/a' }),
      row({ name: 'Хаб', hs_code: null }),
    ]);
    expect(p.rows.map((r) => r.tnved)).toEqual(['8471607000', '', '', '', '']);
    expect(p.rows[1]!.notes).toEqual([{ code: 'seller_code', params: { value: '847160' } }]);
    expect(p.rows[2]!.notes).toEqual([{ code: 'seller_code', params: { value: '84716070' } }]);
    expect(p.rows[3]!.notes).toEqual([]);
  });
});

describe('names', () => {
  it('one line, cut at 200 CODE POINTS with a note — never half an emoji', () => {
    const long = `${'📦'.repeat(150)}${'я'.repeat(100)}`;
    const p = build([row({ name: 'Клавиатура\n  беспроводная\tчёрная' }), row({ name: long })]);
    expect(p.rows[0]!.name).toBe('Клавиатура беспроводная чёрная');
    expect([...p.rows[1]!.name]).toHaveLength(200);
    expect(p.rows[1]!.name.startsWith('📦'.repeat(150))).toBe(true);
    expect(p.rows[1]!.notes).toEqual([{ code: 'name_cut' }]);
    // What it wrote is a name the editor's parser accepts as it stands.
    const line: DraftLine = { name: p.rows[1]!.name, pieces: '', cartons: '', kg: '1', m3: '1', tnved: '' };
    expect(parseDraft([line]).ok).toBe(true);
  });

  it('a name the reading could not give keeps its row — with a note, so the figures are not lost', () => {
    const p = build([row({ name: 'x', pieces: 5 }), row({ name: '', gross_kg: 12 })]);
    expect(p.rows).toHaveLength(2);
    expect(p.rows.map((r) => r.notes[0])).toEqual([{ code: 'name_short' }, { code: 'name_short' }]);
    expect(p.rows[0]!.pieces).toBe('5');
  });

  it('the Russian wording is kept only when it is a second name', () => {
    const p = build([
      row({ name: '键盘', name_ru: 'Клавиатура' }),
      row({ name: 'Мышь', name_ru: ' мышь ' }),
      row({ name: 'Коврик', name_ru: 'К' }),
    ]);
    expect(p.rows.map((r) => r.nameRu)).toEqual(['Клавиатура', null, null]);
  });

  it('a row that names nothing and states nothing is a blank line of the paper', () => {
    const p = build([row({ name: '  ' }), row({ name: 'Мышь', pieces: 3 })]);
    expect(p.rows.map((r) => r.name)).toEqual(['Мышь']);
  });
});

describe('the proposal as a whole', () => {
  it(`lists at most ${READ_MAX_ROWS} rows and says how many there were`, () => {
    const p = build(Array.from({ length: 47 }, (_, i) => row({ name: `Товар ${i + 1}` })));
    expect(p.rows).toHaveLength(READ_MAX_ROWS);
    expect(p.rows.at(-1)!.name).toBe(`Товар ${READ_MAX_ROWS}`);
    expect(p.warnings).toEqual([{ code: 'rows_cut', params: { shown: READ_MAX_ROWS, total: 47 } }]);
  });

  it('carries what the file reader cut and what kind of paper it is', () => {
    const p = buildProposal(answer([row()], { document: 'invoice' }), { rowsCut: true, cellsCut: true });
    expect(p.warnings.map((w) => w.code)).toEqual(['text_cut', 'cells_cut', 'doc_invoice']);
    expect(build([row()], { document: 'other' }).warnings.map((w) => w.code)).toEqual(['doc_other']);
  });

  it('the paper’s own totals are cells too — and absent when it printed none', () => {
    const p = build([row({ cartons: 50, gross_kg: 600, volume_m3: 1.5 })], { totals: { cartons: 50, gross_kg: 600, volume_m3: 1.5 } });
    expect(p.fileTotals).toEqual({ cartons: '50', kg: '600.000', m3: '1.5000' });
    expect(build([row()], { totals: { cartons: null, gross_kg: null, volume_m3: null } }).fileTotals).toBeNull();
    expect(build([row()]).fileTotals).toBeNull();
  });

  it('the misread detector: rows that do not add up to the paper’s own total are SAID, per measure — never corrected', () => {
    const rows = [
      row({ name: 'Мышь', cartons: 50, gross_kg: 600, volume_m3: 1.5 }),
      row({ name: 'Коврик', cartons: 50, gross_kg: 420, volume_m3: 1 }),
    ];
    const p = build(rows, { totals: { cartons: 100, gross_kg: 1240, volume_m3: 2.5 } });
    // 600 + 420 is 1020: a «2» read where the paper prints «6».
    expect(p.warnings).toEqual([{ code: 'totals_differ', params: { field: 'kg', sum: '1020.000', total: '1240.000' } }]);
    expect(p.rows.map((r) => r.kg)).toEqual(['600.000', '420.000']);
    // Adding up: nothing to say.
    expect(build(rows, { totals: { cartons: 100, gross_kg: 1020, volume_m3: 2.5 } }).warnings).toEqual([]);
    // PER MEASURE — the cartons and the cube each have a line of their own (the kilo case above cannot
    // see either: with the cartons' comparison removed every test in this file stayed green).
    expect(build(rows, { totals: { cartons: 120, gross_kg: 1020, volume_m3: 2.5 } }).warnings).toEqual([
      { code: 'totals_differ', params: { field: 'cartons', sum: '100', total: '120' } },
    ]);
    expect(build(rows, { totals: { cartons: 100, gross_kg: 1020, volume_m3: 3 } }).warnings).toEqual([
      { code: 'totals_differ', params: { field: 'm3', sum: '2.5000', total: '3.0000' } },
    ]);
    // All three at once, in the order the dialog prints them.
    expect(build(rows, { totals: { cartons: 120, gross_kg: 1240, volume_m3: 3 } }).warnings.map((w) => w.code === 'totals_differ' && w.params.field)).toEqual([
      'cartons',
      'kg',
      'm3',
    ]);
  });

  it('…and it stays silent where it cannot know: a cut list, a measure some row lacks, net rows against a gross total', () => {
    const totals = { cartons: 100, gross_kg: 1240, volume_m3: 2.5 };
    const some = [row({ name: 'Мышь', cartons: 50, gross_kg: 600 }), row({ name: 'Коврик', net_kg: 400, volume_m3: 1 })];
    expect(build(some, { totals }).warnings).toEqual([]);
    const many = Array.from({ length: 41 }, (_, i) => row({ name: `Т ${i}`, cartons: 1 }));
    expect(build(many, { totals }).warnings.map((w) => w.code)).toEqual(['rows_cut']);
    expect(buildProposal(answer([row({ cartons: 1 })], { totals }), { rowsCut: true, cellsCut: false }).warnings.map((w) => w.code)).toEqual([
      'text_cut',
    ]);
  });

  it('the model’s own remarks travel as they came, on one line and never at any length', () => {
    const p = build([row({ unsure: ' вес указан\nна 3 строки ' })], { notes: `  ${'я'.repeat(900)}  ` });
    expect(p.rows[0]!.unsure).toBe('вес указан на 3 строки');
    expect([...p.notes!]).toHaveLength(600);
    expect(build([row({ unsure: '  ' })]).rows[0]!.unsure).toBeNull();
  });
});

describe('the name a row is applied under', () => {
  const lot = { zh: '键盘', ru: 'Клавиатура' };

  it('1. the lot’s OWN good takes the lot’s own name — whichever of the two names matched', () => {
    expect(appliedName({ name: '键盘', nameRu: 'Клавиатура компьютерная' }, lot)).toEqual({ name: 'Клавиатура', own: true });
    expect(appliedName({ name: 'Keyboard', nameRu: ' клавиатура ' }, lot)).toEqual({ name: 'Клавиатура', own: true });
    expect(appliedName({ name: 'КЛАВИАТУРА', nameRu: null }, lot)).toEqual({ name: 'Клавиатура', own: true });
  });

  it('…and with no stored Russian name it is the lot’s Chinese name — «Bitta tovar»’s own rule, never the translation', () => {
    const zhOnly = { zh: '键盘', ru: null };
    expect(appliedName({ name: '键盘', nameRu: 'Клавиатура' }, zhOnly)).toEqual({ name: '键盘', own: true });
    expect(appliedName({ name: '键盘', nameRu: 'Клавиатура' }, { zh: '键盘', ru: '  ' })).toEqual({ name: '键盘', own: true });
  });

  it('2. another good takes the Russian wording when the model gave one, 3. else the paper’s own words', () => {
    expect(appliedName({ name: '鼠标', nameRu: 'Мышь' }, lot)).toEqual({ name: 'Мышь', own: false });
    expect(appliedName({ name: 'Mouse pad', nameRu: null }, lot)).toEqual({ name: 'Mouse pad', own: false });
  });

  it('what rule 1 writes is a name the save’s `tnved_would_vanish` guard recognises as the lot’s own good', () => {
    // `refuseVanishingCode` asks exactly this of a one-line tarkib (by the
    // memory's key, which `nameKey` restates): a translated name would not pass.
    for (const stored of [lot, { zh: '键盘', ru: null }]) {
      const applied = appliedName({ name: '键盘', nameRu: 'Клавиатура компьютерная' }, stored);
      expect(applied.own).toBe(true);
      expect(lineIsLotGood(applied.name, stored)).toBe(true);
      expect(lineIsLotGood('Клавиатура компьютерная', stored)).toBe(false);
    }
  });

  it('the editor line carries the cells as they are and the name by the rule', () => {
    const [proposed] = build([row({ name: '键盘', name_ru: 'Клавиатура', pieces: 500, cartons: 50, gross_kg: 600, volume_m3: 1.5 })]).rows;
    expect(draftLineOf(proposed!, { zh: '杂货', ru: null })).toEqual({
      name: 'Клавиатура',
      pieces: '500',
      cartons: '50',
      kg: '600.000',
      m3: '1.5000',
      tnved: '',
    });
  });
});

describe('the dialog’s arithmetic', () => {
  const rows: ProposalRow[] = build([
    row({ name: 'Мышь', cartons: 50, gross_kg: 600, volume_m3: 1.5 }),
    row({ name: 'Коврик', cartons: 30, gross_kg: 300, volume_m3: 0.75 }),
    row({ name: 'Гарнитура', gross_kg: 100 }),
  ]).rows;

  it('everything is ticked to begin with ONLY when that cannot be wrong: ≤ 20 rows and a prixod of one lot', () => {
    expect(tickedToBegin({ rows, lotsOnReceipt: 1 })).toBe(true);
    expect(tickedToBegin({ rows, lotsOnReceipt: 2 })).toBe(false);
    const many = build(Array.from({ length: 21 }, (_, i) => row({ name: `Т ${i}` }))).rows;
    expect(tickedToBegin({ rows: many, lotsOnReceipt: 1 })).toBe(false);
    expect(tickedToBegin({ rows: many.slice(0, 20), lotsOnReceipt: 1 })).toBe(true);
  });

  it('Σ of the ticked rows per measure, in the columns’ units — and how many ticked rows state no such figure', () => {
    expect(tickedSums(rows, new Set([0, 1]))).toEqual({
      count: 2,
      cartons: 80,
      kgUnits: 900_000,
      m3Units: 22_500,
      missing: { cartons: 0, kg: 0, m3: 0 },
    });
    expect(tickedSums(rows, new Set([0, 2]))).toEqual({
      count: 2,
      cartons: 50,
      kgUnits: 700_000,
      m3Units: 15_000,
      missing: { cartons: 1, kg: 0, m3: 1 },
    });
    expect(tickedSums(rows, new Set()).count).toBe(0);
  });

  it('cartons stated on some ticked rows and not on others is said, never repaired', () => {
    expect(cartonsMixed(rows, new Set([0, 1]))).toBe(false);
    expect(cartonsMixed(rows, new Set([0, 2]))).toBe(true);
    expect(cartonsMixed(rows, new Set([2]))).toBe(false);
  });

  it('names that occur twice by the tarkib’s own key are named once, as first written', () => {
    expect(duplicateNames(['Мышь', ' мышь ', 'Коврик', 'МЫШЬ', 'Коврик'])).toEqual(['Мышь', 'Коврик']);
    expect(duplicateNames(['Мышь', 'Коврик', ''])).toEqual([]);
  });
});

describe('Apply', () => {
  const lot = { zh: '键盘', ru: 'Клавиатура' };
  const rows = build([
    row({ name: 'Мышь', pieces: 100, cartons: 10, gross_kg: 50, volume_m3: 0.5 }),
    row({ name: 'Коврик', gross_kg: 20, volume_m3: 0.2 }),
    row({ name: ' мышь', gross_kg: 5, volume_m3: 0.1 }),
    row({ name: '键盘', name_ru: 'Клавиатура игровая', gross_kg: 9, volume_m3: 0.1 }),
    row({ name: 'Keyboard', name_ru: 'клавиатура', gross_kg: 9, volume_m3: 0.1 }),
  ]).rows;
  const typed: DraftLine = { name: 'Наушники', pieces: '', cartons: '', kg: '3', m3: '0.1', tnved: '' };
  const blank: DraftLine = { name: '', pieces: '', cartons: '', kg: '', m3: '', tnved: '' };
  const apply = (ticked: number[], how: 'replace' | 'append' = 'replace', existing: DraftLine[] = [blank]) =>
    applyProposal({ rows, ticked: new Set(ticked), lot, existing, how });

  it('nothing ticked is refused', () => {
    expect(apply([])).toEqual({ ok: false, refusal: { code: 'none' } });
  });

  it('more than twenty is refused in a number', () => {
    const many = build(Array.from({ length: 21 }, (_, i) => row({ name: `Товар ${i}` }))).rows;
    const out = applyProposal({ rows: many, ticked: new Set(many.map((_, i) => i)), lot, existing: [], how: 'replace' });
    expect(out).toEqual({ ok: false, refusal: { code: 'too_many', n: 21 } });
    expect(applyProposal({ rows: many, ticked: new Set(many.slice(0, 20).map((_, i) => i)), lot, existing: [], how: 'replace' }).ok).toBe(true);
  });

  it('two ticked rows of one name are refused and NAMED — nothing is ever added together', () => {
    expect(apply([0, 1, 2])).toEqual({ ok: false, refusal: { code: 'duplicates', names: ['Мышь'] } });
    // …also when the two are one name only AFTER the name rule: both are the lot's own good.
    expect(apply([3, 4])).toEqual({ ok: false, refusal: { code: 'duplicates', names: ['Клавиатура'] } });
  });

  it('replace: the ticked rows, in the paper’s order, are the editor’s lines', () => {
    const out = apply([1, 0]);
    expect(out.ok && out.lines.map((l) => l.name)).toEqual(['Мышь', 'Коврик']);
    expect(out.ok && out.lines[0]).toEqual({ name: 'Мышь', pieces: '100', cartons: '10', kg: '50.000', m3: '0.5000', tnved: '' });
  });

  it('append: what a person typed stays in front, blank rows go', () => {
    expect(hasTypedLines([blank, typed])).toBe(true);
    expect(hasTypedLines([blank])).toBe(false);
    const out = apply([0, 1], 'append', [blank, typed, blank]);
    expect(out.ok && out.lines.map((l) => l.name)).toEqual(['Наушники', 'Мышь', 'Коврик']);
  });

  it('append past twenty lines, or of a name already typed, is refused in words — the typed rows untouched', () => {
    const full = Array.from({ length: 19 }, (_, i) => ({ ...typed, name: `Товар ${i}` }));
    expect(apply([0, 1], 'append', full)).toEqual({ ok: false, refusal: { code: 'append_overflow', have: 19, add: 2 } });
    expect(apply([0], 'append', full).ok).toBe(true);
    expect(apply([0, 1], 'append', [{ ...typed, name: 'МЫШЬ ' }])).toEqual({
      ok: false,
      refusal: { code: 'append_duplicates', names: ['Мышь'] },
    });
  });
});
