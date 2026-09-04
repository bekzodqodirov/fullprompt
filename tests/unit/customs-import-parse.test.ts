import { describe, expect, it } from 'vitest';
import {
  FIELD_LABELS,
  mapUnit,
  normalizeHeader,
  normalizeName,
  parseDate,
  parseNumber,
  fitNumeric,
  parseRow,
  priceDrift,
  readHeader,
  REQUIRED_FIELDS,
} from '@/modules/wms/customs/import-parse';
import { BASIS_FOR_UNIT, UNIT_FOR_BASIS, unitsForRow } from '@/modules/wms/customs/import-baza';

/**
 * The quarterly customs dump, decided purely (docs/VED-IMPORT-AI.md §1).
 *
 * His own answer 1b is the reason every one of these exists: the columns may
 * be renamed or reordered between quarters, so a parser that reads by
 * POSITION would take prices out of the weight column the first time the
 * customs service touches the template — and it would look perfectly filled
 * in on the screen.
 */

/** His file's real header row, in his file's real order. */
const HIS_HEADER = [
  '№',
  'С графа',
  'Отправитель',
  '31-Гр-Страна происхождения',
  'ТИФ ТН КОДИ',
  'Товар номи',
  'Нетто',
  'Ед. из.',
  'Кол-во',
  'Вес за ед',
  'Там.стоим $',
  'За.ед. из.$',
];

describe('the header is found by NAME', () => {
  it('reads his own file, whatever the column order', () => {
    const straight = readHeader(HIS_HEADER);
    expect(straight.missing).toEqual([]);
    expect(straight.index.tnvedCode).toBe(4);
    expect(straight.index.pricePerUnit).toBe(11);

    // The same columns, shuffled the way a new quarter's template would.
    const shuffled = [...HIS_HEADER].reverse();
    const back = readHeader(shuffled);
    expect(back.missing).toEqual([]);
    expect(shuffled[back.index.pricePerUnit!]).toBe('За.ед. из.$');
    expect(shuffled[back.index.tnvedCode!]).toBe('ТИФ ТН КОДИ');
  });

  it('one header, however it is punctuated or cased', () => {
    expect(normalizeHeader('За.ед. из.$')).toBe(normalizeHeader('ЗА ЕД ИЗ $'));
    expect(normalizeHeader('  Ед.  из. ')).toBe('ед из');
  });

  it('names the required columns a file is missing', () => {
    const { missing } = readHeader(['№', 'Отправитель', 'Нетто']);
    expect(missing).toEqual(REQUIRED_FIELDS);
    // The refusal must be readable by the admin who uploaded the file, so
    // every field has a label in the file's own words.
    for (const f of missing) expect(FIELD_LABELS[f]).toBeTruthy();
  });

  it('the duplicated «Страна происхождения» takes the first column only', () => {
    const { index } = readHeader([...HIS_HEADER, 'Страна происхождения']);
    expect(index.originCountry).toBe(3);
  });
});

describe('the unit words', () => {
  it('maps what his file actually writes', () => {
    expect(mapUnit('КГ')).toBe('kg');
    expect(mapUnit('шт.')).toBe('dona');
    expect(mapUnit('М2')).toBe('m2');
    expect(mapUnit('пар')).toBe('juft');
    expect(mapUnit('Л')).toBe('litr');
  });

  it('refuses a unit it cannot price rather than guessing one', () => {
    // «компл» could be a set of four or of four hundred. A guessed unit
    // prices the whole line wrong while looking filled in.
    expect(mapUnit('компл')).toBeNull();
    expect(mapUnit('')).toBeNull();
    expect(mapUnit(undefined)).toBeNull();
  });

  it('the unit ↔ basis pair is a bijection', () => {
    for (const [unit, basis] of Object.entries(BASIS_FOR_UNIT)) {
      expect(UNIT_FOR_BASIS[basis]).toBe(unit);
    }
  });
});

describe('which of the file’s units may price a row', () => {
  const both = { hasWeight: true, hasQuantity: true };

  it('a law that PINS a unit admits that one and nothing else', () => {
    // A per-kg price landing on a per-m² row is off by the weight of the
    // goods, which is the whole reason the unit is checked at all.
    expect(unitsForRow({ dutyUnit: 'm2', ...both })).toEqual(['m2']);
    expect(unitsForRow({ dutyUnit: 'juft', ...both })).toEqual(['juft']);
    expect(unitsForRow({ dutyUnit: 'litr', ...both })).toEqual(['litr']);
    expect(unitsForRow({ dutyUnit: 'kg', ...both })).toEqual(['kg']);
  });

  it('an ordinary advalor code takes kilograms first', () => {
    // 74 % of his file is declared per kilogram and an advalor code pins no
    // unit at all — asking per-dona alone would have refused three quarters
    // of every quarter's file.
    expect(unitsForRow({ dutyUnit: null, ...both })).toEqual(['kg', 'dona']);
    expect(unitsForRow({ dutyUnit: null, hasWeight: true, hasQuantity: false })).toEqual(['kg']);
    expect(unitsForRow({ dutyUnit: null, hasWeight: false, hasQuantity: true })).toEqual(['dona']);
  });

  it('a law that COUNTS pieces takes pieces first, and still allows kilograms', () => {
    // The specific duty is charged per piece; the customs VALUE is a
    // separate question and a per-kg declaration answers it perfectly well.
    expect(unitsForRow({ dutyUnit: 'dona', ...both })).toEqual(['dona', 'kg']);
    expect(unitsForRow({ dutyUnit: '1000_dona', ...both })).toEqual(['dona', 'kg']);
  });

  it('a row stating neither a weight nor a count gets no suggestion at all', () => {
    expect(unitsForRow({ dutyUnit: null, hasWeight: false, hasQuantity: false })).toEqual([]);
  });
});

describe('the name the trigram index is built on', () => {
  it('strips the file’s «1. » line-number prefix', () => {
    expect(normalizeName('1. Подшипник шариковый')).toBe('подшипник шариковый');
    expect(normalizeName('12) ПОДШИПНИК   шариковый')).toBe('подшипник шариковый');
  });

  it('keeps the whole name — a VED may type either half', () => {
    // His file writes a Russian name and an English one in one cell.
    const both = normalizeName('1. Подшипник шариковый / Deep groove ball bearing');
    expect(both).toContain('подшипник');
    expect(both).toContain('deep groove');
  });
});

describe('numbers and dates as the file writes them', () => {
  it('reads «1 234,56» and a real number alike', () => {
    expect(parseNumber('1 234,56')).toBeCloseTo(1234.56, 4);
    expect(parseNumber(2.5)).toBe(2.5);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('—')).toBeNull();
  });

  it('reads a Date cell, an Excel serial and a dotted string alike', () => {
    expect(parseDate(new Date(Date.UTC(2026, 4, 17)))).toBe('2026-05-17');
    // exceljs's STREAM reader — the one 500k rows must use — hands back the
    // raw serial where the in-memory reader hands back a Date. Measured on
    // his own file: 46201 is 2026-06-28.
    expect(parseDate(46201)).toBe('2026-06-28');
    // A bare number that is not a date must not become one.
    expect(parseDate(2516)).toBeNull();
    expect(parseDate('17.05.2026')).toBe('2026-05-17');
    expect(parseDate('2026-05-17 00:00')).toBe('2026-05-17');
    expect(parseDate('kecha')).toBeNull();
  });
});

describe('one row', () => {
  const header = readHeader(HIS_HEADER).index;
  const row = (patch: Record<string, unknown> = {}) => {
    const cells: unknown[] = [];
    cells[header.declaredAt!] = '17.05.2026';
    cells[header.sender!] = 'NINGBO CO LTD';
    cells[header.originCountry!] = 'КИТАЙ';
    cells[header.tnvedCode!] = '8482109008';
    cells[header.name!] = '1. Подшипник шариковый';
    cells[header.netto!] = '344';
    cells[header.unit!] = 'шт';
    cells[header.weightPerUnit!] = '0,688';
    cells[header.customsValue!] = '1000';
    cells[header.pricePerUnit!] = '2';
    for (const [k, v] of Object.entries(patch)) {
      cells[header[k as keyof typeof header]!] = v;
    }
    return cells;
  };

  it('reads his sample row whole', () => {
    const res = parseRow(row(), header);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row).toMatchObject({
      tnvedCode: '8482109008',
      unit: 'dona',
      pricePerUnitUsd: 2,
      weightPerUnitKg: 0.688,
      declaredAt: '2026-05-17',
      sender: 'NINGBO CO LTD',
    });
    expect(res.row.nameNorm).toBe('подшипник шариковый');
  });

  it('refuses, with a REASON, every way a row can be unusable', () => {
    expect(parseRow(row({ tnvedCode: '84' }), header)).toMatchObject({ reason: 'bad_code' });
    expect(parseRow(row({ name: '   ' }), header)).toMatchObject({ reason: 'no_name' });
    expect(parseRow(row({ unit: 'компл' }), header)).toMatchObject({ reason: 'unknown_unit' });
    expect(parseRow(row({ pricePerUnit: '0' }), header)).toMatchObject({ reason: 'bad_price' });
    expect(parseRow(row({ pricePerUnit: '' }), header)).toMatchObject({ reason: 'bad_price' });
  });

  it('a zero price is refused and not stored as a baza of nothing', () => {
    // The column's own CHECK would refuse it; refusing here keeps one bad
    // row from taking a whole thousand-row chunk down with it.
    const res = parseRow(row({ pricePerUnit: '-3' }), header);
    expect(res.ok).toBe(false);
  });

  it('the kg self-check notices a price that disagrees with the file', () => {
    // Only on kg rows: customs value ÷ netto IS the per-kg price there, and
    // a wide gap means the columns were read wrong — the loudest possible
    // signal that a new quarter renamed something.
    const kg = parseRow(row({ unit: 'кг', netto: '500', customsValue: '1000', pricePerUnit: '2' }), header);
    expect(kg.ok).toBe(true);
    if (kg.ok) expect(priceDrift(kg.row)).toBeLessThan(0.01);

    const wrong = parseRow(row({ unit: 'кг', netto: '500', customsValue: '1000', pricePerUnit: '20' }), header);
    if (wrong.ok) expect(priceDrift(wrong.row)).toBeGreaterThan(0.5);

    // A per-piece row has no such arithmetic and must not be judged by it.
    const piece = parseRow(row(), header);
    if (piece.ok) expect(priceDrift(piece.row)).toBeNull();
  });
});

/**
 * The column's own limits, applied where the guard is (his June file).
 *
 * The whole import stopped on `customs_import_rows_weight_check`. Measured,
 * both halves: 0.00004 is `> 0` in JavaScript and `0.0000` in
 * numeric(12,4) — so a row passed every parser guard and was refused by the
 * table, and the chunk it rode in took 999 good rows down with it.
 */
describe('a figure is fitted to its column before it is judged', () => {
  it('a weight that rounds away at the column scale is no weight', () => {
    // The exact shape that stopped his quarter.
    expect(fitNumeric(0.00004, 12, 4)).toBe(0);
    expect(fitNumeric(0.00006, 12, 4)).toBe(0.0001);
  });

  it('refuses a figure the column cannot hold, rather than clipping it', () => {
    // numeric(12,4) holds eight integer digits. Storing a DIFFERENT number
    // is worse than storing none: a baza nobody can trace is not a baza.
    expect(fitNumeric(100_000_000, 12, 4)).toBeNull();
    expect(fitNumeric(99_999_999.9, 12, 4)).toBe(99_999_999.9);
    expect(fitNumeric(Infinity, 14, 4)).toBeNull();
    expect(fitNumeric(NaN, 14, 4)).toBeNull();
    expect(fitNumeric(null, 14, 4)).toBeNull();
  });

  it('a row whose weight rounds to zero keeps its price and drops the weight', () => {
    const header = readHeader(['ТИФ ТН КОДИ', 'Товар номи', 'За.ед.из.$', 'Ед.из.', 'Вес за ед']);
    const parsed = parseRow(['6203420000', 'Брюки', '12.5', 'кг', '0.00004'], header.index);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The row is still a real declaration and still prices the code.
    expect(parsed.row.pricePerUnitUsd).toBe(12.5);
    // Nulled here, so the CHECK never sees a zero.
    expect(parsed.row.weightPerUnitKg).toBeNull();
  });

  it('a PRICE that rounds away is refused, not stored as zero', () => {
    const header = readHeader(['ТИФ ТН КОДИ', 'Товар номи', 'За.ед.из.$', 'Ед.из.']);
    const parsed = parseRow(['6203420000', 'Брюки', '0.00004', 'кг'], header.index);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('bad_price');
  });
});
