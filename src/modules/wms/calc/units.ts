/**
 * What a person MEANT by «120 m2», «40 juft», «1 200 kg» or «20 karobka» —
 * read ONE way at every door a calculation is fed through (the seller's card
 * form, the VED's paste box, the bot's typed facts and line answers, an
 * invoice file). Pure and import-light, because the browser asks it too.
 *
 * Why it exists (the owner, 2026-10-09: «tnved code va dona m2 juftda
 * otadgan tovarlarni kirgizadgan joyi yoqku … kg hamda donani birga
 * kirgizadgan tovarlar bor»): every door used to put the number in the DONA
 * column and keep the unit word as display-only text. «Kafel, 120, m2» was
 * 120 pieces of tile, «Kurtka, 500, kg» was 500 jackets, «Lak 50 litr» lost
 * its 50 altogether, and «1 200 kg» was read as 200. The engine then priced a
 * per-piece baza, or a per-piece floor, on a number that was never a count.
 *
 * The rule this file encodes: a number lands in the column its unit NAMES —
 * dona → quantity, kg → weight, m³ → volume, m²/juft/litr/sm³ → the measure
 * pair (0092). A carton count is NOT pieces and lands nowhere a price reads
 * (the line then asks how many pieces). An unknown word keeps the number off
 * every priced column. A number that could be read two ways is ASKED, never
 * guessed (his B4 a — `readNumberCell`).
 */
import { readNumberCell } from './number-cell';
import type { MeasureUnit } from './pricing';

/** The columns a number can land in, plus the two that are deliberately not a column. */
export type SellerUnit = 'dona' | 'kg' | 'm3' | 'm2' | 'juft' | 'litr' | 'sm3' | 'karobka';

/**
 * The words people actually write, lower-cased, dots and spaces removed.
 * Uzbek (Latin and Cyrillic), Russian, English and the Chinese packing-list
 * words. «件» is deliberately ABSENT: on a Chinese list it means a piece on
 * one invoice and a package on the next, and a wrong guess is a 24-fold
 * error — an unknown word asks.
 */
const WORDS: Record<SellerUnit, readonly string[]> = {
  dona: [
    'dona', 'донa', 'дона', 'ta', 'та', 'sht', 'шт', 'штук', 'штука', 'штуки', 'pcs', 'pc', 'piece',
    'pieces', 'ед', 'единиц', 'единица', 'adet', '个', '只', 'компл', 'комплект', 'комплекта',
    'komplekt', 'set', 'sets', '套', 'nabor', 'набор',
  ],
  kg: ['kg', 'кг', 'kilo', 'kilogramm', 'kilogram', 'килограмм', 'килограм', 'kgs', '公斤', '千克'],
  m3: ['m3', 'm³', 'м3', 'м³', 'kub', 'куб', 'кубм', 'cbm', 'kubm', '立方米', '立方', '方'],
  m2: [
    'm2', 'm²', 'м2', 'м²', 'квм', 'кв', 'kvm', 'kv', 'sqm', 'sq', 'кв.м', '平方米', '平米',
    'metrkvadrat',
  ],
  juft: ['juft', 'жуфт', 'пар', 'пара', 'пары', 'pair', 'pairs', 'pr', 'prs', '双', '对'],
  litr: ['litr', 'литр', 'литра', 'литров', 'l', 'л', 'liter', 'litre', 'liters', 'litres', 'ltr', '升'],
  sm3: ['sm3', 'sm³', 'см3', 'см³', 'cm3', 'cm³', 'cc', 'кубсм'],
  karobka: [
    'karobka', 'karopka', 'korobka', 'коробка', 'коробки', 'коробок', 'кор', 'qop', 'ctn', 'ctns',
    'carton', 'cartons', 'box', 'boxes', 'кути', 'quti', '箱', 'место', 'мест', 'места', 'joy',
  ],
};

const LOOKUP = new Map<string, SellerUnit>();
for (const [unit, words] of Object.entries(WORDS) as [SellerUnit, readonly string[]][]) {
  for (const w of words) LOOKUP.set(normalizeWord(w), unit);
}

function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[.\s ]/g, '');
}

/** The unit a word names, or null when it names none this file knows. An
 * empty word is not «unknown» — callers decide what a bare number means. */
export function unitOf(word: string | null | undefined): SellerUnit | null {
  if (!word) return null;
  const key = normalizeWord(word);
  if (!key) return null;
  return LOOKUP.get(key) ?? null;
}

/**
 * Where a stated amount belongs. `cartons` and `unknownUnit` are not columns:
 * a carton count is a fact about the packing, not the goods (the line must
 * still say how many pieces), and an unknown word keeps its number out of
 * every column a price is computed from.
 */
export type Routed =
  | { quantity: number }
  | { weightKg: number }
  | { volumeM3: number }
  | { measureUnit: MeasureUnit; measureQty: number }
  | { cartons: number }
  | { unknownUnit: string; value: number };

export function routeAmount(value: number, unitWord: string | null | undefined): Routed {
  const word = unitWord?.trim() ?? '';
  // No word at all: the convention every door has always had — «nomi, soni».
  if (!word) return { quantity: value };
  const unit = unitOf(word);
  switch (unit) {
    case 'dona':
      return { quantity: value };
    case 'kg':
      return { weightKg: value };
    case 'm3':
      return { volumeM3: value };
    case 'm2':
    case 'juft':
    case 'litr':
    case 'sm3':
      return { measureUnit: unit, measureQty: value };
    case 'karobka':
      return { cartons: value };
    case null:
      return { unknownUnit: word.slice(0, 20), value };
  }
}

/**
 * A number typed in free text — a phone keyboard, a Telegram message, a line
 * of a pasted list — read with the cell's own rules (`readNumberCell`) and
 * ONE addition: «1.200» is ambiguous here too. A cell is a number box where
 * the dot is this office's decimal; a sentence is somebody's Russian, where
 * «1.200 кг» is twelve hundred.
 */
export type Amount =
  | { state: 'ok'; value: number }
  | { state: 'ambiguous'; decimal: number; thousands: number }
  | { state: 'bad' };

const DOT_THOUSANDS = /^[1-9]\d{0,2}\.\d{3}$/;

export function readAmountText(raw: string): Amount {
  const text = raw.trim();
  if (DOT_THOUSANDS.test(text)) {
    return { state: 'ambiguous', decimal: Number(text), thousands: Number(text.replace('.', '')) };
  }
  const cell = readNumberCell(text);
  if (cell.state === 'ok') return cell.value > 0 ? cell : { state: 'bad' };
  if (cell.state === 'ambiguous') {
    return { state: 'ambiguous', decimal: cell.decimal, thousands: cell.thousands };
  }
  return { state: 'bad' };
}

/**
 * A TNVED code as people write it in a line of text: ten digits, or the dotted
 * or spaced form «6907.21.00.00» / «6907 21 00 00», or a shorter code that is
 * LABELLED («kod 6907», «ТН ВЭД 640399»). A bare short number is never taken
 * as a code — «Stol 1000» is a thousand tables.
 */
const CODE_LABEL = /(?:^|[\s,;(])(?:tnved|тнвэд|тн\s?вэд|tn\s?ved|hs|kod|код|code)\s*[:=№#-]?\s*(\d{4,10})(?!\d)/iu;
const CODE_DOTTED = /(?<![\d.])(\d{4})[. ](\d{2})(?:[. ](\d{2}))?(?:[. ](\d{2}))?(?![\d.,])/u;
const CODE_TEN = /(?<![\d.,])(\d{10})(?![\d.,])/u;

export function codeIn(text: string): { code: string; start: number; end: number } | null {
  const labelled = CODE_LABEL.exec(text);
  if (labelled) {
    const start = labelled.index + labelled[0].indexOf(labelled[1]!);
    return { code: labelled[1]!, start: labelled.index, end: start + labelled[1]!.length };
  }
  const ten = CODE_TEN.exec(text);
  if (ten) return { code: ten[1]!, start: ten.index, end: ten.index + ten[0].length };
  const dotted = CODE_DOTTED.exec(text);
  // At least three groups («6907.21.00»): «1200 50» is two numbers, not a code.
  if (dotted && dotted[3] !== undefined) {
    const code = [dotted[1], dotted[2], dotted[3], dotted[4]].filter(Boolean).join('');
    return { code, start: dotted.index, end: dotted.index + dotted[0].length };
  }
  return null;
}

/**
 * One line of a goods list, read.
 *
 * Accepts the shapes people produce: «Kafel plitka, 120, m2» (the old «name,
 * quantity, unit» columns), «Kafel plitka 120 m2», «Kurtka 300 dona 150 kg»
 * (BOTH a count and a weight — clothing pays a per-piece floor on a per-kg
 * baza), «Kabel; 2,5; kg» (a decimal comma is a decimal, never a column
 * break), a tab-separated spreadsheet row, and a code anywhere on the line.
 * Problems are returned, never swallowed: the caller words them.
 */
export interface GoodsLine {
  name: string;
  tnvedCode: string | null;
  quantity: number | null;
  weightKg: number | null;
  volumeM3: number | null;
  measureUnit: MeasureUnit | null;
  measureQty: number | null;
  /** The seller's own words for what the numbers were, kept for the screen. */
  unitWords: string[];
  cartons: number | null;
  problems: GoodsLineProblem[];
}

export type GoodsLineProblem =
  | { kind: 'ambiguous'; text: string; decimal: number; thousands: number }
  | { kind: 'unknown_unit'; word: string; value: number }
  | { kind: 'two_pairs'; units: MeasureUnit[] }
  | { kind: 'repeated'; unit: SellerUnit }
  | { kind: 'cartons_only'; cartons: number };

/**
 * An amount and the word after it. Digits may be grouped by single spaces in
 * threes («1 200», «12 500 000»); a decimal part follows a dot or a comma.
 * The word is letters (any script), ², ³ or a dotted abbreviation like «кв.м».
 * A number glued to letters on its left («A54», «iPhone15») is never an
 * amount.
 */
const AMOUNT =
  /(?<![\p{L}\d.,])(\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?![\d])(?:\s*([\p{L}²³][\p{L}\d²³.]*))?/gu;

/** A cell that is only a code — four to ten digits, dots/spaces allowed. A
 * four-digit one must look like a heading (chapter 01-97, heading 01-99):
 * «1000» is a thousand of something, not heading 10.00. */
function isCodeCell(cell: string): string | null {
  if (/^\d+[.,]\d{1,3}$/.test(cell.trim())) return null; // «2,5» / «1.25» are amounts
  const bare = cell.replace(/[.\s]/g, '');
  if (!/^\d{4,10}$/.test(bare)) return null;
  if (bare.length >= 6) return bare;
  return /^(0[1-9]|[1-8]\d|9[0-7])(0[1-9]|[1-9]\d)$/.test(bare) ? bare : null;
}

export function parseGoodsLine(raw: string): GoodsLine {
  const line: GoodsLine = {
    name: '',
    tnvedCode: null,
    quantity: null,
    weightKg: null,
    volumeM3: null,
    measureUnit: null,
    measureQty: null,
    unitWords: [],
    cartons: null,
    problems: [],
  };
  if (!raw.trim()) return line;

  // Columns: a tab or a semicolon always; a comma only when it is not between
  // two digits — «2,5» is a number, «Kabel, 2,5, kg» is three columns.
  const cells = (/[\t;]/.test(raw) ? raw.split(/[\t;]/) : raw.split(/,(?!\d)|(?<!\d),/))
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  // A CODE column (an Excel «Код ТН ВЭД»): a cell that is only a code, in a
  // row where another cell carries the name. It is taken only BEFORE the
  // first amount-bearing cell — «Stol; 1000» is a thousand tables, and so is
  // «Stol; 1001», whatever heading 10.01 is.
  const hasName = cells.some((c) => /\p{L}/u.test(c));
  const kept: string[] = [];
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i]!;
    const code = line.tnvedCode === null && hasName && cells.length > 1 ? isCodeCell(cell) : null;
    const nameSeen = kept.some((c) => /\p{L}/u.test(c));
    if (code !== null && (code.length === 10 || !nameSeen)) {
      line.tnvedCode = code;
      continue;
    }
    kept.push(cell);
  }
  let text = kept.join(' ');

  if (line.tnvedCode === null) {
    const found = codeIn(text);
    if (found) {
      line.tnvedCode = found.code;
      text = `${text.slice(0, found.start)} ${text.slice(found.end)}`;
    }
  }

  let unknown: { word: string; value: number } | null = null;
  const consumed: [number, number][] = [];
  const bare: { value: number; start: number; end: number }[] = [];
  const taken = new Set<SellerUnit>();
  for (const hit of text.matchAll(AMOUNT)) {
    const whole = hit[0];
    const number = hit[1]!;
    const word = hit[2] ?? null;
    const start = hit.index!;
    const end = start + whole.length;
    const unit = word ? unitOf(word) : null;
    // «iPhone 15 Pro», «Stul 2 xil» — a number followed by a word that is not
    // a unit belongs to the NAME. Leave it where it is — but remember it: on a
    // line that states nothing else, «Ткань 300 м» is an amount in a unit
    // this file does not price, and that must be ASKED, not dropped.
    if (word && unit === null) {
      const amount = readAmountText(number);
      if (amount.state === 'ok') unknown = { word, value: amount.value };
      continue;
    }
    const amount = readAmountText(number);
    if (amount.state === 'bad') continue;
    if (amount.state === 'ambiguous') {
      consumed.push([start, end]);
      line.problems.push({ kind: 'ambiguous', text: number, decimal: amount.decimal, thousands: amount.thousands });
      continue;
    }
    if (!word) {
      bare.push({ value: amount.value, start, end });
      continue;
    }
    consumed.push([start, end]);
    line.unitWords.push(word);
    const routed = routeAmount(amount.value, word);
    const key = unit!;
    if (taken.has(key)) {
      line.problems.push({ kind: 'repeated', unit: key });
      continue;
    }
    taken.add(key);
    if ('quantity' in routed) line.quantity = routed.quantity;
    else if ('weightKg' in routed) line.weightKg = routed.weightKg;
    else if ('volumeM3' in routed) line.volumeM3 = routed.volumeM3;
    else if ('measureUnit' in routed) {
      if (line.measureUnit !== null && line.measureUnit !== routed.measureUnit) {
        line.problems.push({ kind: 'two_pairs', units: [line.measureUnit, routed.measureUnit] });
        continue;
      }
      line.measureUnit = routed.measureUnit;
      line.measureQty = routed.measureQty;
    } else if ('cartons' in routed) line.cartons = routed.cartons;
  }

  // A number with no word is the COUNT — «nomi, soni», the convention every
  // door has always had — but only the LAST one: «Stul 2 21» keeps «2» in the
  // name. And never when a count was spelt out («40 dona» wins).
  const count = bare.at(-1);
  if (count && line.quantity === null) {
    line.quantity = count.value;
    consumed.push([count.start, count.end]);
  }

  let name = text;
  for (const [start, end] of consumed.sort((a, b) => b[0] - a[0])) {
    name = `${name.slice(0, start)} ${name.slice(end)}`;
  }
  line.name = name.replace(/[\s,;:]+/gu, ' ').trim();

  const statesNothing =
    line.quantity === null &&
    line.weightKg === null &&
    line.volumeM3 === null &&
    line.measureQty === null &&
    line.cartons === null;
  if (statesNothing && unknown !== null) {
    line.problems.push({ kind: 'unknown_unit', word: unknown.word.slice(0, 20), value: unknown.value });
  }
  if (line.cartons !== null && line.quantity === null && line.weightKg === null && line.measureQty === null) {
    line.problems.push({ kind: 'cartons_only', cartons: line.cartons });
  }
  return line;
}
