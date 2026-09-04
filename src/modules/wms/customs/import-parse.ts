/**
 * The customs dump's own shape, as PURE decisions (docs/VED-IMPORT-AI.md §1).
 *
 * His file comes from the customs service every three months and its columns
 * MAY be renamed or reordered between quarters (his answer 1b), so every
 * column is found by its HEADER NAME and never by position — a positional
 * parser silently reads prices out of the weight column the first time the
 * service changes anything.
 *
 * Zero imports on purpose: the header matrix, the unit map and the name
 * normalisation are the round's most-tested rules, and they must be callable
 * from a unit test with no database, no storage and no Excel.
 */

/** The five units this system can price. The file's own words map onto them. */
export type ImportUnit = 'kg' | 'dona' | 'm2' | 'juft' | 'litr';

/**
 * The file's unit words → ours. Measured on his sample: кг 74 %, шт 25 %,
 * м2 / пар / л under half a percent between them.
 *
 * Anything else is SKIPPED and counted, never guessed: «компл» could be a
 * set of four or of four hundred, and a wrong unit prices the whole line
 * wrong while looking perfectly filled in.
 */
const UNIT_WORDS: Record<string, ImportUnit> = {
  кг: 'kg',
  kg: 'kg',
  килограмм: 'kg',
  шт: 'dona',
  штук: 'dona',
  дона: 'dona',
  pcs: 'dona',
  м2: 'm2',
  'м²': 'm2',
  m2: 'm2',
  'кв м': 'm2',
  пар: 'juft',
  пара: 'juft',
  juft: 'juft',
  л: 'litr',
  литр: 'litr',
  l: 'litr',
};

export function mapUnit(raw: unknown): ImportUnit | null {
  const word = String(raw ?? '')
    .toLowerCase()
    .replace(/[.\s]+/g, ' ')
    .trim();
  return UNIT_WORDS[word] ?? null;
}

/** The columns the import needs; everything else in the file is ignored. */
export type ImportField =
  | 'tnvedCode'
  | 'name'
  | 'pricePerUnit'
  | 'unit'
  | 'weightPerUnit'
  | 'netto'
  | 'customsValue'
  | 'declaredAt'
  | 'sender'
  | 'originCountry';

export const REQUIRED_FIELDS: ImportField[] = ['tnvedCode', 'name', 'pricePerUnit', 'unit'];

/**
 * Header text → field, matched on a NORMALISED form (lowercase, punctuation
 * and spaces collapsed) so «За.ед. из.$», «за ед из $» and «ЗА.ЕД.ИЗ.$» are
 * one header. Each field lists every spelling seen or plausibly coming.
 *
 * `Страна происхождения` appears TWICE in his file (once prefixed
 * «31-Гр-»); first match wins and both mean the same thing.
 */
const HEADER_WORDS: [ImportField, string[]][] = [
  ['tnvedCode', ['тиф тн коди', 'тн вэд', 'тнвэд', 'код тнвэд', 'тн вэд коди', 'kod tnved']],
  ['name', ['товар номи', 'наименование товара', 'товар', 'наименование', 'tovar nomi']],
  ['pricePerUnit', ['за ед из $', 'за ед изм $', 'цена за единицу', 'за ед из']],
  ['unit', ['ед из', 'ед изм', 'единица измерения', 'улчов бирлиги', 'olchov birligi']],
  ['weightPerUnit', ['вес за ед', 'вес за единицу', 'вес ед']],
  ['netto', ['нетто', 'вес нетто', 'netto']],
  // DOLLARS only, and that is measured, not assumed: his file carries
  // «Божхона киймати» (30 015.09) beside «Там.стоим $» (4 415.15) for the
  // same line — the first is the CONTRACT currency (yuan here) and only the
  // second divides by the netto to give the price column. A column called
  // «customs value» in a currency nobody named would have made the kg
  // self-check read 64 % drift on a perfectly good file, which is exactly
  // what it did before this list was narrowed.
  ['customsValue', ['там стоим $', 'там стоим', 'таможенная стоимость $', 'customs value usd']],
  ['declaredAt', ['с графа', 'дата', 'сана', 'дата декларации']],
  ['sender', ['отправитель', 'юборувчи', 'поставщик']],
  ['originCountry', ['страна происхождения', '31 гр страна происхождения', 'келиб чикиш мамлакати']],
];

export function normalizeHeader(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[.,;:_/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface HeaderMap {
  /** field → zero-based column index in the sheet's row array. */
  index: Partial<Record<ImportField, number>>;
  /** Required fields the header row does not carry, in declaration order. */
  missing: ImportField[];
}

/**
 * Read the header row. A header this map does not know is simply ignored —
 * the file carries 24 columns and the import needs ten of them.
 */
export function readHeader(cells: unknown[]): HeaderMap {
  const index: Partial<Record<ImportField, number>> = {};
  cells.forEach((cell, i) => {
    const norm = normalizeHeader(cell);
    if (!norm) return;
    for (const [field, words] of HEADER_WORDS) {
      if (index[field] !== undefined) continue;
      if (words.includes(norm)) {
        index[field] = i;
        return;
      }
    }
  });
  return { index, missing: REQUIRED_FIELDS.filter((f) => index[f] === undefined) };
}

/** The human name of a field, for the refusal that names what is missing. */
export const FIELD_LABELS: Record<ImportField, string> = {
  tnvedCode: 'ТИФ ТН КОДИ',
  name: 'Товар номи',
  pricePerUnit: 'За.ед. из.$',
  unit: 'Ед. из.',
  weightPerUnit: 'Вес за ед',
  netto: 'Нетто',
  customsValue: 'Там.стоим $',
  declaredAt: 'С графа',
  sender: 'Отправитель',
  originCountry: 'Страна происхождения',
};

/**
 * The string the trigram index is built on.
 *
 * Lowercased, the «1. » line-number prefix stripped (the file writes it on
 * almost every row), whitespace collapsed. The WHOLE remaining string is
 * kept — his names carry a Russian half and an English half («Подшипник
 * шариковый / Deep groove ball bearing») and a VED may type either.
 */
export function normalizeName(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/^\s*\d+\s*[.)]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Numbers arrive as numbers, as «1 234,56» strings, or as nothing. */
export function parseNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const cleaned = String(raw).replace(/\s/g, '').replace(',', '.');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * «С графа» — a date, in the three shapes this file arrives in.
 *
 * MEASURED, and it is the reason this function has a number branch at all:
 * exceljs's in-memory reader hands back a real `Date`, and its STREAMING
 * reader — the one the import must use for 500k rows — hands back the raw
 * Excel SERIAL (46201). Reading only the two obvious shapes stored a NULL
 * date on every row of a file that carries one, so the batch could not say
 * which quarter it covers.
 */
export function parseDate(raw: unknown): string | null {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toISOString().slice(0, 10);
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Excel counts days from 1899-12-30. The window is 1954-2064: a bare
    // number outside it is some other column's quantity, not a date.
    if (raw < 20_000 || raw > 60_000) return null;
    return new Date(Math.round(raw) * 86_400_000 + Date.UTC(1899, 11, 30))
      .toISOString()
      .slice(0, 10);
  }
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dotted = text.match(/^(\d{2})[.\/](\d{2})[.\/](\d{4})/);
  if (dotted) return `${dotted[3]}-${dotted[2]}-${dotted[1]}`;
  return null;
}

export interface ParsedImportRow {
  tnvedCode: string;
  name: string;
  nameNorm: string;
  unit: ImportUnit;
  pricePerUnitUsd: number;
  weightPerUnitKg: number | null;
  nettoKg: number | null;
  customsValueUsd: number | null;
  declaredAt: string | null;
  sender: string | null;
  originCountry: string | null;
}

/** Why a row was not imported — counted, and the commonest one is logged. */
export type SkipReason = 'bad_code' | 'no_name' | 'bad_price' | 'unknown_unit';

const CODE_SHAPE = /^\d{4,10}$/;

/**
 * One sheet row → one import row, or a named refusal.
 *
 * Deliberately total: every rejection has a reason the job can count, so
 * «205 qator o'tmadi» can say WHY on the screen rather than leaving the
 * admin to guess whether the file was wrong or the parser was.
 */
export function parseRow(
  cells: unknown[],
  header: HeaderMap['index'],
): { ok: true; row: ParsedImportRow } | { ok: false; reason: SkipReason } {
  const at = (field: ImportField): unknown => {
    const i = header[field];
    return i === undefined ? undefined : cells[i];
  };

  const code = String(at('tnvedCode') ?? '')
    .replace(/\s/g, '')
    .trim();
  if (!CODE_SHAPE.test(code)) return { ok: false, reason: 'bad_code' };

  const name = String(at('name') ?? '').trim();
  if (!name) return { ok: false, reason: 'no_name' };

  const unit = mapUnit(at('unit'));
  if (!unit) return { ok: false, reason: 'unknown_unit' };

  const price = parseNumber(at('pricePerUnit'));
  // A zero or negative price is not a baza; the column's own CHECK would
  // refuse it, and one bad row must not take the whole chunk down.
  if (price === null || !(price > 0)) return { ok: false, reason: 'bad_price' };

  const weight = parseNumber(at('weightPerUnit'));

  return {
    ok: true,
    row: {
      tnvedCode: code,
      name: name.slice(0, 500),
      nameNorm: normalizeName(name).slice(0, 500),
      unit,
      pricePerUnitUsd: price,
      weightPerUnitKg: weight !== null && weight > 0 ? weight : null,
      nettoKg: parseNumber(at('netto')),
      customsValueUsd: parseNumber(at('customsValue')),
      declaredAt: parseDate(at('declaredAt')),
      sender: (String(at('sender') ?? '').trim() || null)?.slice(0, 300) ?? null,
      originCountry: (String(at('originCountry') ?? '').trim() || null)?.slice(0, 120) ?? null,
    },
  };
}

/**
 * The self-check the spec asks for: on kg rows the file's own per-unit price
 * should be its customs value over its netto weight. Measured on his sample
 * it holds; if a future file breaks it, the price column means something
 * else and importing it silently would put a wrong baza on every row.
 */
export function priceDrift(row: ParsedImportRow): number | null {
  if (row.unit !== 'kg') return null;
  if (row.customsValueUsd === null || row.nettoKg === null || row.nettoKg <= 0) return null;
  const expected = row.customsValueUsd / row.nettoKg;
  if (!Number.isFinite(expected) || expected <= 0) return null;
  return Math.abs(expected - row.pricePerUnitUsd) / expected;
}
