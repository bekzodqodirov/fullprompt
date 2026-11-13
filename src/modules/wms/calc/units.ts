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
import { addressWord } from './address-words';
import { emptyPacking, parseSize, wholeCartons, type BareSize, type Packing, type PerCartonUnit, type SizeOwner } from './carton-math';
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
  kg: [
    'kg', 'кг', 'kilo', 'кило', 'kilogramm', 'kilogram', 'килограмм', 'килограм', 'килограмма',
    'килограммов', 'kgs', '公斤', '千克',
  ],
  m3: [
    'm3', 'm³', 'м3', 'м³', 'kub', 'куб', 'куба', 'кубов', 'kubov', 'кубм', 'кбм', 'cbm', 'kubm',
    'kubometr', 'кубометр', 'кубометра', 'кубометров', 'cum', 'cu.m', 'cubic meter', 'cubic meters',
    'cubic metre', 'cubic metres', '立方米', '立方', '方',
  ],
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

/**
 * The cube's COUNTED forms — «2 куба», «4 кубов», «12 kubov»: how Russian
 * counts cubic metres, and also how a toy states the cubes it is made of
 * (review JN-22: «Набор 4 кубов 20 шт» carried a volume of 4 m³). Units of
 * `WORDS.m3` all the same; `parseGoodsLine` and the totals reader keep such a
 * figure in the NAME on a line that also states its pieces.
 */
export const COUNTED_CUBES: ReadonlySet<string> = new Set(['куба', 'кубов', 'kubov']);

/**
 * The words of ONE unit, as written (docs/AI-SORAYDI.md §2.4). Every reader
 * of a shipment's total, a table answer or a totals-shaped message asks HERE
 * — three private lists were the reason «5 kub» was an answer and «5 cbm»
 * (the word on every Chinese packing list) was «jadvalda bunday qator yo‘q».
 */
export function unitWords(unit: SellerUnit): readonly string[] {
  return WORDS[unit];
}

const escapeRe = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A regex alternation of a unit's words, longest first (so «kgs» is not read
 * «kg» + a stray «s», «кубов» not «куб» + «ов»), a dot inside a word optional
 * («cu.m» and «cum»), the space of a PHRASE any white space or none («cubic
 * meters», «cubicmeters» — review JN-22: the phrase stood in the list as one
 * glued word nothing a person types could reach). The SOURCE of a group — the
 * caller adds its own boundaries, as the readers differ in what may stand on
 * either side.
 */
export function unitPattern(unit: SellerUnit): string {
  return wordsPattern(WORDS[unit]);
}

/** `unitPattern`'s alternation over any word list — the scaled kilo words (`SCALED_KG`) ask it too. */
function wordsPattern(words: readonly string[]): string {
  return [...words]
    .sort((a, b) => b.length - a.length)
    .map((w) => escapeRe(w).replace(/\\\./g, '\\.?').replace(/ /g, '\\s*'))
    .join('|');
}

/**
 * The unit PHRASES of `WORDS` — two words that are one unit («cubic meters»),
 * as a regex source, longest first. Derived, so a phrase added to a list above
 * is read by every reader the day it is added.
 */
const PHRASES = (Object.values(WORDS) as (readonly string[])[])
  .flat()
  .filter((w) => w.includes(' '))
  .sort((a, b) => b.length - a.length)
  .map((w) => escapeRe(w).replace(/ /g, '\\s+'))
  .join('|');
const UNIT_PHRASE = new RegExp(`(?<![\\p{L}])(?:${PHRASES})(?![\\p{L}])`, 'giu');

/**
 * A text with the unit phrase after a number written as one word — «5.9 cubic
 * meters» → «5.9 cubicmeters» — for a reader that splits on spaces (the
 * table's name address): `unitOf` reads both spellings. After a NUMBER only:
 * «Cubic meter gauge» is a product's name. (The number is looked for in the
 * few characters before the phrase, in code — a look-behind over `\s*` is
 * walked from every position of a long run of spaces.)
 */
export function joinUnitPhrases(text: string): string {
  return text.replace(UNIT_PHRASE, (m, at: number) =>
    /\d\s{0,3}$/u.test(text.slice(Math.max(0, at - 4), at)) ? m.replace(/\s+/gu, '') : m,
  );
}

/**
 * The LABELS of a totals line and of a supplier's spec block, in the scripts
 * they arrive in (§2.4). Lower-case; a reader folds what it compares.
 *  - a weight label says the figure after it is kilos even with no unit
 *    («G.W.: 507»); a NET label says which weight it is;
 *  - a volume label says cubic metres («CBM: 5.92», «MEAS: 5.92»);
 *  - a field label opens a line of a spec block («品名 折叠椅», «尺寸 60*40*50»)
 *    — such a line is never a goods line of its own (MP-3).
 * «件数» is a CARTON label only beside a piece label («数量»): alone it is as
 * ambiguous as «件» itself, and stays out.
 */
export const WEIGHT_LABELS: readonly string[] = [
  'g.w.', 'g.w', 'gw', 'g/w', 'gross weight', 'gross', 'brutto', 'брутто', 'вес брутто', 'общий вес',
  'og‘irlik', "og'irlik", 'ogirlik', 'og‘irligi', "og'irligi", 'ogirligi', 'vazn', 'vazni', 'вес', 'масса',
  'total weight', 't.w.', '毛重', '总毛重', '总重',
];
export const NET_LABELS: readonly string[] = [
  'n.w.', 'n.w', 'nw', 'n/w', 'net weight', 'net wt.', 'net wt', 'net', 'netto', 'нетто', 'вес нетто',
  'sof og‘irlik', "sof og'irlik", 'sof ogirlik', 'sof og‘irligi', "sof og'irligi", 'sof ogirligi', '净重', '总净重',
];
export const VOLUME_LABELS: readonly string[] = [
  'cbm', 'meas.', 'meas', 'measurement', 'volume', 'vol.', 'vol', 'cube', 'cubage', 'hajmi', 'hajm',
  'kub', 'объём', 'объем', 'куб', '体积', '总体积', '方数', '总方数',
];

/**
 * The labels after which a figure needs NO unit — «G.W.: 507», «CBM = 5.92»
 * (docs/AI-SORAYDI.md §3.1 T1, review JN-21). Only the ones that can name
 * nothing but that measure: «gross» and «net» head a money line («Gross:
 * 12 500»), «vol», «cube», «kub», «куб» are product nouns («Manga Vol 3»,
 * «Magic cube 3»), and «вес», «vazn», «масса» say a weight without saying
 * WHICH — after those the unit must be written. Each is a word of its list
 * above (fenced), so nothing here is a second vocabulary.
 */
export const UNIT_FREE_LABELS = {
  weightKg: [
    'g.w.', 'g.w', 'gw', 'g/w', 'gross weight', 'brutto', 'брутто', 'вес брутто', 'og‘irlik', "og'irlik",
    'ogirlik', 'og‘irligi', "og'irligi", 'ogirligi', '毛重', '总毛重',
  ],
  netKg: [
    'n.w.', 'n.w', 'nw', 'n/w', 'net weight', 'netto', 'нетто', 'вес нетто', 'sof og‘irlik', "sof og'irlik",
    'sof ogirlik', 'sof og‘irligi', "sof og'irligi", 'sof ogirligi', '净重', '总净重',
  ],
  volumeM3: ['cbm', 'meas.', 'meas', 'measurement', 'hajmi', 'hajm', 'объём', 'объем', '体积', '总体积'],
} as const satisfies Record<string, readonly string[]>;

/**
 * The labels a totals ANSWER may open with at the bot's table — «og‘irligi
 * 3500», «вес 3500 кг», «hajmi 12» (line-address.ts `totalsLead`). There the
 * bot has just asked for the shipment's weight and cube, so «вес» and «gross»
 * are kilos even bare; a product noun («kub», «cube», «масса для лепки») is
 * still not one — it may be the name of a row. Words of the lists above
 * (fenced): the table reads its field words HERE and keeps none of its own.
 */
export const TOTALS_LEAD_LABELS = {
  weightKg: ['brutto', 'брутто', 'gross', 'og‘irlik', 'og‘irligi', 'vazn', 'vazni', 'вес', 'общий вес'],
  volumeM3: ['hajm', 'hajmi', 'объём', 'объем'],
} as const satisfies Record<string, readonly string[]>;

/**
 * A label list as a regex alternation, longest first: a dot optional and a
 * space allowed after it («G.W.», «G. W.», «GW»), a space any white space
 * («gross  weight»), every apostrophe a phone types — or none — for the one
 * in «og‘irlik». The caller adds its own boundaries.
 */
export function labelPattern(labels: readonly string[]): string {
  return [...labels]
    .sort((a, b) => b.length - a.length)
    .map((l) =>
      escapeRe(l)
        .replace(/\\\.(?=.)/g, '\\.?\\s?')
        .replace(/\\\.$/g, '\\.?')
        .replace(/ /g, '\\s*')
        .replace(/[‘']/g, '[’ʻʼ‘`´\']?'),
    )
    .join('|');
}

/**
 * The TONNE and the GRAM — scaled spellings of the kilo (§3.1 T14, CR-7). A
 * scaled unit is a word of `kg` with a factor, never a unit of its own: it has
 * no column, no key in `WORDS`, and `unitOf` does not know it — so the card
 * form, the VED's paste box and a sheet's unit cells read exactly what they
 * read before (review JR-22: only the bot's typed readers are to ask for it).
 *
 * Read by the bot's typed readers alone — `routeAmount` and `parseGoodsLine`
 * on request (`scaled`), the shipment-totals reader and the table's answers
 * (intake-manual.ts, line-address.ts). To every other door «2 tonna» is the
 * unknown unit it always was.
 *
 * Only spellings that can be nothing else are words (review JN-9). The single
 * letters «t», «т», «g», «г» and «mt» are capacities and generations far more
 * often than weights in this trade — «Fleshka 128G», «Router 5G», «Domkrat
 * 5T», «2024 г» — so they are `lone`: to be read only where the figure IS a
 * weight (after a weight label, or as the whole answer to the bot's own weight
 * question), never glued to its digits and never before a slash («180 g/m2»).
 */
export const SCALED_KG = [
  { factor: 1000, words: ['tonna', 'ton', 'tons', 'тн', 'тонн', 'тонна', 'тонны', 'тонну', 'тонне', 'тонной', '吨'], lone: ['t', 'т', 'mt'] },
  { factor: 0.001, words: ['gr', 'gramm', 'гр', 'грамм', 'грамма', 'граммов', '克'], lone: ['g', 'г'] },
] as const;

export interface ScaledKg {
  factor: number;
  /** A single letter (or «mt»): a weight only where nothing else can be meant. */
  lone: boolean;
}

const SCALED_LOOKUP = new Map<string, ScaledKg>();
for (const { factor, words, lone } of SCALED_KG) {
  for (const w of words) SCALED_LOOKUP.set(normalizeWord(w), { factor, lone: false });
  for (const w of lone) SCALED_LOOKUP.set(normalizeWord(w), { factor, lone: true });
}

/** The scale a word names — a tonne, a gram — or null. Never a `SellerUnit`. */
export function scaledKg(word: string | null | undefined): ScaledKg | null {
  if (!word) return null;
  return SCALED_LOOKUP.get(normalizeWord(word)) ?? null;
}

/** `unitPattern` for the scaled kilo words — the full spellings, or the lone letters. */
export function scaledPattern(kind: 'words' | 'lone'): string {
  return wordsPattern(SCALED_KG.flatMap((s) => (kind === 'words' ? [...s.words] : [...s.lone])));
}

/** A scaled figure in kilos — «2,5 тн» is 2500, «500 gr» 0.5; six places, so 0.001 × 20 is 0.02 and not 0.020000000000000004. */
export const scaledKgValue = (value: number, factor: number): number => Number((value * factor).toFixed(6));

export const FIELD_LABELS = {
  name: [
    '品名', '货名', '名称', '产品', 'product', 'item', 'description', 'goods', 'наименование', 'товар',
    'название', 'nomi', 'tovar', 'mahsulot',
  ],
  count: ['数量', 'qty', 'quantity', 'кол-во', 'количество', 'soni', 'miqdori'],
  cartons: ['箱数', 'ctns', 'cartons', 'packages', 'pkgs', 'мест', 'коробок', 'karobka soni', 'joy soni'],
  // WHOSE size a label names decides the arithmetic (review JN-11, PR-12):
  // only a PACKAGE's size is multiplied by the packages. A label that says
  // «carton» is the package's; a bare «size» says nobody's — the size is kept
  // with `of: null`, and its owner is asked, never guessed.
  packageSize: [
    '外箱尺寸', '箱规', '纸箱尺寸', 'carton size', 'ctn size', 'carton dimensions', 'meas (cm)', 'meas(cm)',
    'размер коробки', 'размер места', 'размер упаковки', 'karobka o‘lchami', "karobka o'lchami",
    'karobka olchami', 'quti o‘lchami', "quti o'lchami",
  ],
  // «razmer(i)» — the Russian word as an Uzbek seller types it («karobka razmeri 60x40x50 sm», DIM-4).
  size: [
    '尺寸', 'size', 'dimensions', 'dims', 'l*w*h', 'lxwxh', 'размер', 'размеры', 'габариты', 'o‘lchami', "o'lchami",
    'olchami', 'razmer', 'razmeri',
  ],
} as const satisfies Record<string, readonly string[]>;

/**
 * What marks a figure as ONE PACKAGE's / ONE PIECE's, written right after it
 * («15 kg/箱», «0.12 cbm/ctn», «4.5 kg/шт»). The slash is part of the mark: a
 * bare «ctn» after a number is a carton COUNT, not a tail.
 */
export const PER_PACKAGE_TAIL: readonly string[] = [
  // «/件» is NOT here (review JN-8): «件» is a piece as often as a package,
  // and a tail that may be either marks nothing.
  '/箱', '/ctn', '/ctns', '/carton', '/box', '/кор', '/коробка', '/коробку', '/место', '/karobka',
  '/quti', '/joy',
  // A sack is a package of its own trade — cement, flour, granules: «50 kg/qop» (T4).
  '/qop', '/bag', '/мешок',
];
export const PER_PIECE_TAIL: readonly string[] = ['/pc', '/pcs', '/piece', '/шт', '/штука', '/dona', '/ta', '/个', '/只'];

/** Does `text`, from `at`, open with one of `tails` (spaces around the slash allowed)? The matched length, or 0. */
export function tailAt(text: string, at: number, tails: readonly string[]): number {
  const rest = text.slice(at);
  const lead = /^\s*\/\s*/u.exec(rest);
  if (!lead) return 0;
  const after = rest.slice(lead[0].length).toLowerCase();
  let best = 0;
  for (const tail of tails) {
    const word = tail.slice(1);
    if (!after.startsWith(word)) continue;
    // A Latin/Cyrillic tail must END there («/ctn» is not «/ctnr»); a Han tail needs no boundary.
    const next = after.charAt(word.length);
    if (/[\p{Script=Latin}\p{Script=Cyrillic}]/u.test(word.slice(-1)) && /[\p{L}\d]/u.test(next)) continue;
    best = Math.max(best, lead[0].length + word.length);
  }
  return best;
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
  /** `scaled`: the kilos were written in tonnes or grams — «2 tonna» is `{ weightKg: 2000, scaled: { value: 2, word: 'tonna' } }`. */
  | { weightKg: number; scaled?: { value: number; word: string } }
  | { volumeM3: number }
  | { measureUnit: MeasureUnit; measureQty: number }
  | { cartons: number }
  | { unknownUnit: string; value: number };

/**
 * `opts.scaled` (docs/AI-SORAYDI.md §3.1 T14): read a TONNE or a GRAM as the
 * kilos it is — the full spellings only (`SCALED_KG`'s `words`; a lone «t» or
 * «g» is a capacity as often as a weight, review JN-9, and is the caller's to
 * place). Asked for by the bot's typed readers ALONE (review JR-22): with no
 * option the card form, the VED's paste box and a sheet's unit cells read
 * «2 tonna» as the unknown unit it always was.
 */
export function routeAmount(value: number, unitWord: string | null | undefined, opts: { scaled?: boolean } = {}): Routed {
  const word = unitWord?.trim() ?? '';
  // No word at all: the convention every door has always had — «nomi, soni».
  if (!word) return { quantity: value };
  const scale = opts.scaled ? scaledKg(word) : null;
  if (scale && !scale.lone) return { weightKg: scaledKgValue(value, scale.factor), scaled: { value, word } };
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
/** «1.136,5» — dot groups AND a decimal comma: the mirror of «1,136.5», and as little a question. */
const DOT_GROUPS_COMMA = /^\d{1,3}(?:\.\d{3})+,\d+$/;
/** The apostrophes a phone types between digit groups («1'200», «1’200») — the cell reader knows the plain one. */
const GROUP_APOSTROPHES = /[’ʼʻ]/g;

export function readAmountText(raw: string): Amount {
  const text = raw.trim().replace(GROUP_APOSTROPHES, "'");
  if (DOT_THOUSANDS.test(text)) {
    return { state: 'ambiguous', decimal: Number(text), thousands: Number(text.replace('.', '')) };
  }
  if (DOT_GROUPS_COMMA.test(text)) {
    const value = Number(text.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(value) && value > 0 ? { state: 'ok', value } : { state: 'bad' };
  }
  const cell = readNumberCell(text);
  if (cell.state === 'ok') return cell.value > 0 ? cell : { state: 'bad' };
  if (cell.state === 'ambiguous') {
    return { state: 'ambiguous', decimal: cell.decimal, thousands: cell.thousands };
  }
  return { state: 'bad' };
}

/**
 * The book's LAST heading of every chapter, two digits each for chapters
 * 01-97 («00»: chapter 77 is reserved and has none). Derived from the PP-3818
 * book every code here is priced by (`pp3818-rates.json`, all 1,228 of its
 * headings) and fenced against it by a test (`tnved-notation.test.ts`) — a
 * table and not the book, because this module ships to the browser and the
 * book is half a megabyte.
 */
const LAST_HEADING =
  '0610091011041414100809140204220504060509' +
  '0609090430211653420605150707070607272617' +
  '1506042104020723110713121108160905111106' +
  '1717100607030415142018292619081600060707' +
  '1315118749091607083314090706082006';

/**
 * Do the first four digits open a REAL heading — chapter 01-97 and a heading
 * from 01 up to that chapter's last (R3-T5)? «xx00» is no heading, and nor is
 * «1250»: chapter 12 ends at 1214. The round-3 rule (any heading 01-99) let
 * «Ayollar kurtkasi 1250 50 3000» — price, count, sum — read as the code
 * 1250503000, and the comment called the two texts one «without the tariff's
 * own list of headings»; the list is the book, and this is its shape.
 */
export function opensRealHeading(code: string): boolean {
  if (!/^\d{4}/.test(code)) return false;
  const chapter = Number(code.slice(0, 2));
  const heading = Number(code.slice(2, 4));
  if (chapter < 1 || chapter > 97 || heading < 1) return false;
  return heading <= Number(LAST_HEADING.slice((chapter - 1) * 2, chapter * 2));
}

/**
 * A TNVED code as people write it in a line of text: ten digits, or the dotted,
 * spaced or hyphenated form «6907.21.00.00» / «6907 21 00 00» / «6907-21-00-00»,
 * or a shorter code that is LABELLED («kod 6907», «ТН ВЭД 640399»). A bare
 * short number is never taken as a code — «Stol 1000» is a thousand tables.
 * The written forms open with a real heading (`opensRealHeading`, R3-T5):
 * «Kurtka 1200 50 30» is three numbers, not the code 12005030.
 */
const CODE_LABEL = /(?:^|[\s,;(])(?:tnved|тнвэд|тн\s?вэд|tn\s?ved|hs|kod|код|code)\s*[:=№#-]?\s*(\d{4,10})(?!\d)/iu;
const CODE_DOTTED = /(?<![\d.])(?<!\d-)(\d{4})[. -](\d{2})(?:[. -](\d{2}))?(?:[. -](\d{2}))?(?![\d.,])(?!-\d)/gu;
const CODE_TEN = /(?<![\d.,])(\d{10})(?![\d.,])/u;
/**
 * The two forms a customs declaration and the PP-3818 book PRINT a ten-digit
 * code in — 4-2-4 «6201 93 0000» and 4-2-3-1 «2710 19 820 0», with spaces,
 * dots or hyphens (round-1 review 2, T3; «Kurtka 6201-93-0000» was read as a
 * PHONE, round-3 note). Only 4-2-2-2 was known, so «Kurtka 6201 93 000 0»
 * stated no goods and the bot filed it as the customer's phone.
 *
 * The first group must open a real heading (`opensRealHeading`, R3-T5). A
 * chapter alone let a row of plain numbers through: «Kurtka 1200 50 3000»,
 * «Futbolka 2000 10 5000» (price, count, sum, copied from a PDF) were read as
 * the codes 1200503000 and 2000105000, grouping the row and pulling a law by
 * its prefix.
 */
const CODE_PRINTED =
  /(?<![\d.])(?<!\d-)(\d{4})[. -](\d{2})[. -](?:(\d{4})|(\d{3})[. -](\d))(?![\d.,])(?!-\d)/gu;

/**
 * Is everything after a SPACED code on the line a row of bare unit-less
 * numbers — «Kurtka 1500 30 2400 12.5», «Kurtka 6201 93 00 00 300» (round-4
 * T-r1 ND8, T-r2 ND6)? Then the run is a row of figures copied without its
 * units and nothing in it is a code. Only a PURE row: a size, a count in a
 * unit, a price with its «$», «№1» or a bracket after the code are what a
 * goods line carries beside its code — the round-3 rule refused the code
 * when ANY bare number followed it anywhere, and «Kurtka 6201 93 0000 300
 * dona 12.5$» lost its code into the name. A dotted or hyphenated code is
 * never a row: nobody prints figures so.
 */
function pureRowAfter(text: string, end: number): boolean {
  return /^(?:\s+\d[\d.,]*)+\s*$/u.test(text.slice(end));
}

/**
 * The first match of a written-code form that IS a code: a real heading, and
 * — for the spaced form — not the head of a row of figures. `accept` says
 * what else the caller needs of it.
 */
function writtenCode(
  re: RegExp,
  text: string,
  accept: (hit: RegExpExecArray, end: number) => boolean,
): RegExpExecArray | null {
  const scan = new RegExp(re.source, re.flags);
  for (let hit = scan.exec(text); hit; hit = scan.exec(text)) {
    const end = hit.index + hit[0].length;
    const spaced = !/[.-]/.test(hit[0]);
    if (opensRealHeading(hit[1]!) && !(spaced && pureRowAfter(text, end)) && accept(hit, end)) return hit;
    scan.lastIndex = hit.index + 1;
  }
  return null;
}

/** The word written right after `end`, when it names a unit — «6201 93 3000 dona» is a
 * subheading and three thousand pieces, never a ten-digit code. */
function unitWordAfter(text: string, end: number): boolean {
  const word = /^\s*([\p{L}²³][\p{L}\d²³.]*)/u.exec(text.slice(end));
  return word !== null && unitOf(word[1]) !== null;
}

/** A printed or dotted code that starts exactly at `at` — what a label points at. */
function writtenCodeAt(text: string, at: number): { code: string; end: number } | null {
  for (const re of [CODE_PRINTED, CODE_DOTTED]) {
    const sticky = new RegExp(re.source, 'uy');
    sticky.lastIndex = at;
    const hit = sticky.exec(text);
    if (!hit || !opensRealHeading(hit[1]!)) continue;
    const groups = hit.slice(1).filter((g): g is string => g !== undefined);
    const end = at + hit[0].length;
    // Three groups at least for the dotted form (below), and never a code
    // whose last group is a count in a unit.
    if (groups.length < 3 || (re === CODE_PRINTED && unitWordAfter(text, end))) continue;
    return { code: groups.join(''), end };
  }
  return null;
}

export function codeIn(text: string): { code: string; start: number; end: number } | null {
  const labelled = CODE_LABEL.exec(text);
  if (labelled) {
    const start = labelled.index + labelled[0].indexOf(labelled[1]!);
    // «tnved 6201.93.0000»: the label points at the WHOLE printed code, not at
    // its first four digits with «.93.0000» left behind as figures (T3).
    const whole = writtenCodeAt(text, start);
    if (whole) return { code: whole.code, start: labelled.index, end: whole.end };
    return { code: labelled[1]!, start: labelled.index, end: start + labelled[1]!.length };
  }
  const ten = CODE_TEN.exec(text);
  if (ten) return { code: ten[1]!, start: ten.index, end: ten.index + ten[0].length };
  const printed = writtenCode(CODE_PRINTED, text, (_, end) => !unitWordAfter(text, end));
  if (printed) {
    const code = printed.slice(1).filter(Boolean).join('');
    return { code, start: printed.index, end: printed.index + printed[0].length };
  }
  // At least three groups («6907.21.00»): «1200 50» is two numbers, not a code.
  const dotted = writtenCode(CODE_DOTTED, text, (hit) => hit[3] !== undefined);
  if (dotted) {
    const code = [dotted[1], dotted[2], dotted[3], dotted[4]].filter(Boolean).join('');
    return { code, start: dotted.index, end: dotted.index + dotted[0].length };
  }
  return null;
}

/**
 * Is `code` (as `codeIn` found it in `text`) WRITTEN as a code — dotted, spaced
 * or printed — rather than ten digits that could be anybody's number? A phone
 * is never written 4-2-…, so such a line names goods even with no word beside
 * it (T3: «6201.93.0000», «2710 19 820 0» typed alone).
 */
export function codeWrittenAsCode(text: string): boolean {
  const found = codeIn(text);
  if (!found) return false;
  const digitsAt = text.slice(found.start, found.end).search(/\d/);
  return /[. -]/.test(text.slice(found.start + digitsAt, found.end));
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
 *
 * COLUMNS ARE READ ONE AT A TIME. A thousands group never crosses a column
 * boundary: «Kurtka; 300; 150 kg» is 300 and 150 kg, never 300 150 kg — the
 * spec judge measured the first version welding two cells into 300150 (a
 * weight a thousand times too high under a per-kg floor).
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
  /**
   * What the line states PER PACKAGE or PER PIECE, and the package's size —
   * read only for the bot's typed readers (`opts.packing`, docs/AI-SORAYDI.md
   * §3.1 T4/T6). Such a figure is never in the columns above: «20 karobka,
   * har biri 15 kg» is 15 kg of ONE carton, and the carton arithmetic
   * (`applyPacking`) makes the line's from it. Absent without the option.
   */
  packing?: Packing | null;
  /**
   * Figures nobody can place — a per-one figure whose owner the line does not
   * say («har biri 2 kg» beside a piece AND a carton count), a cube of one
   * piece, a grouped number asked for both readings («1 200 dona») — as the
   * seller wrote them: off every column, kept for the row's note.
   */
  aside?: string[];
  /** Every per-one figure of the line as written, placed or not — an ANSWER holding one is refused. */
  perOne?: string[];
}

export type GoodsLineProblem =
  /**
   * A number with two readings. «1,200»: `decimal` 1.2, `thousands` 1200.
   * `grouped` (review JN-6): a space-grouped number after a name word or a
   * bare number — «stul 20 300 kg» — whose first group may be a count, a
   * model, a code: `decimal` then carries the reading WITHOUT that group
   * (300) and `thousands` the whole (20300). Asked like the other, never
   * guessed; the two share a kind because every door already words it.
   */
  | { kind: 'ambiguous'; text: string; decimal: number; thousands: number; grouped?: true }
  | { kind: 'unknown_unit'; word: string; value: number }
  | { kind: 'two_pairs'; units: MeasureUnit[] }
  | { kind: 'repeated'; unit: SellerUnit }
  | { kind: 'cartons_only'; cartons: number }
  /** Two or more numbers in separate columns with no unit word: which is the
   * count and which the weight is a guess, and a guess here is money. */
  | { kind: 'unlabelled'; values: number[] }
  /** A code of nine digits as TEXT — a leading zero lost somewhere. */
  | { kind: 'code_short'; text: string };

// ── a number is not welded onto its neighbour (docs/AI-SORAYDI.md §3.1 T0) ──
//
// «1 200 kg» is twelve hundred: a number is 1-3 digits and then groups of
// three after ONE gap each. So is «…60x40x50 300kg» fifty thousand three
// hundred — to a reader that takes whatever digits stand before the gap for
// the thousands. It did: a carton's height, a client code («GS 777 300 kg» —
// 777 300 kg), a count («stul 20 300 kg») or a model («iPhone 15 128 kg»)
// became the thousands of the weight after it, under ✅ and over the model's
// correct 300 (MP-1: a ≈ $239 job priced ≈ $34 936). The rule, as the review
// ruled it (JN-5, JN-6, JS-24), for every reader of free text:
//
//  1. what is no amount is BLANKED before the amounts are read — a size, a
//     code's digits (and, for the totals reader, a phone and a client code);
//  2. a space-grouped number is thousands with no question only where nothing
//     of another fact can stand before it: at the opening of a line or
//     segment, after a totals or measure label, after a figure WITH its unit,
//     after a blanked span or a code;
//  3. after a name word or a bare number it is ASKED, with both readings —
//     «stul 20 300 kg»: 300 or 20300? — never guessed.

/** The gaps a grouped number is written with: a space, a no-break space, a narrow one. */
const GROUP_GAP = String.raw`[ \u00a0\u202f]`;

/** The apostrophes a digit group is set off with — «1'200», «1’200 000». */
const GROUP_APOSTROPHE = String.raw`['’ʼʻ]`;

/**
 * A number as free text writes it — a regex SOURCE: 1-3 digits and groups of
 * three after one gap each («1 200», «12 500 000»), or plain digits; a decimal
 * part after a dot or a comma. ONE grammar for the row kernel below and the
 * shipment-totals reader (intake-manual.ts), which kept a copy.
 *
 * And the way a packing list writes a weight (docs/AI-SORAYDI.md §3.1 T14,
 * CR-7): «1,136.5», «12,500.00» — comma groups AND a decimal point — and its
 * mirror «1.136,5». Neither can be read two ways, yet the grammar stopped at
 * the first separator: «1,136.5 kg» was asked «1.136 mi yoki 1136 mi?» (it is
 * neither) with a stray «.5 kg» left in the name. They stand FIRST: a regex
 * takes the first alternative that matches, and the plain one matches their
 * head. «1,200» alone — one comma group, no decimal — is still two readings,
 * and still asked. An apostrophe between digit groups is a separator
 * («1'200» was 200).
 */
export const AMOUNT_NUMBER = [
  String.raw`\d{1,3}(?:,\d{3})+\.\d+`,
  String.raw`\d{1,3}(?:\.\d{3})+,\d+`,
  String.raw`\d{1,3}(?:${GROUP_APOSTROPHE}\d{3})+(?:[.,]\d+)?`,
  String.raw`\d{1,3}(?:${GROUP_GAP}\d{3})+(?:[.,]\d+)?`,
  String.raw`\d+(?:[.,]\d+)?`,
].join('|');

const GROUPED_NUMBER = new RegExp(String.raw`^\d{1,3}${GROUP_GAP}(\d{3}.*)$`, 'u');

/**
 * The second reading of a space-grouped number — what is left when its first
 * group is something else's: «20 300» → 300, «1 200 000,5» → 200000.5. Null
 * for a number written in one piece (it has one reading).
 */
export function withoutFirstGroup(number: string): number | null {
  const tail = GROUPED_NUMBER.exec(number.trim())?.[1];
  if (tail === undefined) return null;
  const read = readAmountText(tail);
  return read.state === 'ok' ? read.value : null;
}

/**
 * What a span is blanked with before the amounts are read. Private-use: no
 * digit, no letter, no separator — the amount grammar cannot start, continue
 * or group across it — and one character per character, so every offset still
 * points into what the person wrote (the name is cut from THAT).
 */
export const BLANK = '\uE000';

/** `text` with `[start, end)` blanked, its length kept. */
export function blankSpan(text: string, start: number, end: number): string {
  return text.slice(0, start) + BLANK.repeat(Math.max(0, end - start)) + text.slice(end);
}

/**
 * `text` with every span blanked in ONE pass — `blankSpan` in a loop copies
 * the whole text per span, which a long pasted line with thousands of figures
 * turns into seconds. Spans may overlap and come in any order.
 */
export function blankSpans(text: string, spans: readonly [number, number][]): string {
  if (spans.length === 0) return text;
  const parts: string[] = [];
  let at = 0;
  for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0])) {
    const from = Math.max(s, at);
    if (e <= from) continue;
    parts.push(text.slice(at, from), BLANK.repeat(e - from));
    at = e;
  }
  parts.push(text.slice(at));
  return parts.join('');
}

/**
 * Every size of a line blanked — «60x40x50 sm», «600*600», «L60 W40 H50» (the
 * kernel's `parseSize`). A dimension is never an amount: read as one, «1:
 * 60*40*50 15 kg» wrote 50 dona (DIM-3) and «…60*40*50 300 kg» 50 300 kg.
 * The size itself stays in the text the caller cuts the name from.
 */
export function blankSizes(line: string): string {
  let out = line;
  // Each round blanks at least three characters, so the loop ends; the bound
  // is for a line somebody made of nothing but sizes.
  for (let round = 0; round < 40; round += 1) {
    const size = parseSize(out);
    if (!size) break;
    out = blankSpan(out, size.start, size.end);
  }
  return out;
}

/**
 * A code's digits standing where they would be read as the THOUSANDS of the
 * figure after them — «№15 300 kg», «XJ-200 300 kg», «2024/15 300 kg» (review
 * JN-6: «XJ-200 300 kg» was 200 300 kg). A code is a sign («№», «#», «_»)
 * before the digits, or a dash or a slash after one to four letters or after
 * a token that already holds a digit. One to three digits: a longer run
 * («B-00066») opens no grouped number.
 *
 * Only THERE — before a gap and three digits. Anywhere else the digits keep
 * what every reader has always made of them: «Sumka-50 dona» is a figure
 * glued to its name by a dash, and «Partiya YW-123 12 kub» is the typed
 * reader's own case (`gluedCodeLetters`). A whole WORD before the dash
 * («Kurtka-1 200 kg») is a name, and the figure after it is asked like any
 * figure after a name.
 */
const CODE_DIGITS = new RegExp(
  // The token before the dash is BOUNDED (no code is longer), and judged in
  // code below: two open-ended runs around a digit are quadratic on a long
  // pasted token.
  String.raw`(?:[№#_]|(?<![\p{L}\d])([\p{L}\d]{1,24})[-–/])(\d{1,3})(?=${GROUP_GAP}\d{3}(?!\d))`,
  'gu',
);
/** One to four letters («XJ», «YW»), or a token that already holds a digit («A54», «2024»). */
const CODE_TOKEN = /^(?:\p{L}{1,4}|.*\d.*)$/u;

/**
 * A phone as it is typed in groups — «90 123 45 67», «+998 90 123 45 67», «8
 * 916 123 45 67»: every phone here ends in three digits and two pairs. Its
 * last pair was the thousands of the weight after it («Ali aka 90 123 45 67
 * 300 kg» — 67 300 kg, review JN-6), and its groups a count («×45»).
 */
const PHONE_SHAPE = /(?<![\d.,\p{L}])(?:\+?\d{1,3}[ -]?)?\(?\d{2,3}\)?[ -]?\d{3}[ -]\d{2}[ -]\d{2}(?!\d)/gu;

/**
 * A line with everything that is no amount blanked — every size
 * (`blankSizes`), every phone, and the code digits of `CODE_DIGITS`: what
 * the amounts of a line are read from, by the row kernel and by the
 * shipment-totals reader alike.
 */
export function blankNonAmounts(line: string): string {
  let out = blankSizes(line);
  for (const hit of out.matchAll(PHONE_SHAPE)) out = blankSpan(out, hit.index, hit.index + hit[0].length);
  for (const hit of out.matchAll(CODE_DIGITS)) {
    if (hit[1] !== undefined && !CODE_TOKEN.test(hit[1])) continue;
    const end = hit.index + hit[0].length;
    out = blankSpan(out, end - hit[2]!.length, end);
  }
  return out;
}

/**
 * A measure's label closing the text before a figure — «G.W.», «vazni»,
 * «Вес брутто», «hajmi», «soni» — in the spellings `labelPattern` reads. Only
 * the labels that name a measure and nothing else, plus the table's own
 * («вес», «gross»): «Manga Vol 3 200 dona» and «Magic cube 3 200 dona» end in
 * a product noun, and are asked (review JN-21).
 */
const MEASURE_LABEL_BEFORE = new RegExp(
  String.raw`(?:^|[^\p{L}\d])(?:${labelPattern([
    ...UNIT_FREE_LABELS.weightKg,
    ...UNIT_FREE_LABELS.netKg,
    ...UNIT_FREE_LABELS.volumeM3,
    ...TOTALS_LEAD_LABELS.weightKg,
    ...TOTALS_LEAD_LABELS.volumeM3,
    ...FIELD_LABELS.count,
  ])})[.:：]?\s*$`,
  'iu',
);

/** What sets a figure off from the words before it — a comma, a colon, an opening bracket, a list's bullet. */
const OPENS_SEGMENT = /[,;:：=([{|—–.!?•·*+~≈<>«"“]$/u;
/** A dash or a slash does too when it stands apart («Kurtka - 1 200 kg»); glued to a word it is that word's. */
const LOOSE_DASH = /(?:^|\s)[-/]$/u;

export type GroupedReading = 'thousands' | 'ask';

/** How far back `groupedReading` looks: a label of three words, or a counter and a unit with their number. */
const LOOK_BACK = 120;

/**
 * Is the space-grouped number starting at `at` of `line` ONE number — or may
 * its first group be another fact's (rule 2-3 above)? `line` is the text the
 * amounts are read from, blanked (`blankNonAmounts`), one line or one column:
 * its start is where a line or a segment opens. `isLabel` adds the caller's
 * own label words (the totals reader's «jami», «faktik», «taxminan»).
 */
export function groupedReading(line: string, at: number, isLabel: (word: string) => boolean = () => false): GroupedReading {
  // What stands right before the number, the spaces between them set aside —
  // and only the last few words of it: nothing further back is asked, and a
  // whole line re-split per figure is quadratic on a long one.
  let end = Math.min(at, line.length);
  while (end > 0 && /\s/u.test(line.charAt(end - 1))) end -= 1;
  const before = line.slice(Math.max(0, end - LOOK_BACK), end);
  if (before === '' || OPENS_SEGMENT.test(before) || LOOSE_DASH.test(before)) return 'thousands';
  const tokens = before.split(/\s+/u);
  const clean = (token: string) => token.replace(/^[("'«“[]+|[)"'»”\].,;:!?/-]+$/gu, '');
  const raw = tokens.at(-1)!;
  // A size, a code's digits, a phone — blanked: no fact of its own can weld.
  if (raw.includes(BLANK)) return 'thousands';
  const word = clean(raw);
  const bareNumber = (t: string) => /^\d[\d.,]*$/u.test(t);
  if (bareNumber(word)) return 'ask';
  const gluedUnit = (t: string) => {
    const glued = /^\d[\d.,]*([\p{L}²³][\p{L}\d²³.]*)$/u.exec(t);
    return glued !== null && unitOf(glued[1]) !== null;
  };
  // A figure WITH its unit: «300dona», or «300 dona» / «120 ta juft» — the
  // unit words walked back to their number. A unit word with no number
  // before it is a word of the name («Lunch box 1 200 dona»).
  if (gluedUnit(word)) return 'thousands';
  if (unitOf(word) !== null) {
    let i = tokens.length - 2;
    while (i >= 0 && unitOf(clean(tokens[i]!)) !== null) i -= 1;
    const head = i >= 0 ? clean(tokens[i]!) : '';
    return bareNumber(head) || gluedUnit(head) || tokens[i]?.includes(BLANK) ? 'thousands' : 'ask';
  }
  // Letters and digits in one token are a code or a model — «GS777», «A54»,
  // «XJ-200»: its digits are its own, the number after it is whole (JS-24).
  if (/\d/u.test(word) && /\p{L}/u.test(word)) return 'thousands';
  if (TOTAL_WORD.test(word) || MEASURE_LABEL_BEFORE.test(before) || isLabel(word)) return 'thousands';
  return 'ask';
}

/**
 * An amount and the word after it. Digits may be grouped by single gaps in
 * threes («1 200», «12 500 000»); a decimal part follows a dot or a comma.
 * The word is a unit PHRASE («cubic meters» — review JN-22: the phrase stood
 * in the list as one glued word nothing a person types could reach), else
 * letters (any script), ², ³ or a dotted abbreviation like «кв.м» — an
 * apostrophe between letters inside it («og‘irligi», «so‘m»): cut there, «5.9
 * og‘irligi 507» was a figure in a unit «og» (review typed-break-9). A number
 * glued to letters on its left («A54», «iPhone15») is never an amount.
 */
const AMOUNT = new RegExp(
  String.raw`(?<![\p{L}\d.,])(${AMOUNT_NUMBER})(?![\d])(?:\s*(${PHRASES}|[\p{L}²³](?:[\p{L}\d²³.]|['’ʻʼ‘\x60´](?=\p{L}))*))?`,
  'giu',
);

/** A counter word directly before a unit: «120 ta juft», «40 шт пар» — the
 * second word is the unit. */
const COUNTER_THEN_UNIT = /^\s+([\p{L}²³][\p{L}\d²³.]*)/u;

/** One amount of a line and the word that names it, where they stand. */
export interface AmountSpan {
  /** `[start, end)` in the line: the number, and its word when it has one. */
  start: number;
  end: number;
  /** The number as written — «1 200», «5,9». */
  number: string;
  /** The word after it as written: a unit, the unit after a counter («120 ta juft» → «juft»), or any other word. Null for a bare number. */
  word: string | null;
}

/**
 * Every amount of a line with the word after it — the kernel's own grammar
 * (`AMOUNT`, sizes and code digits blanked), for a reader that must ACCOUNT
 * for each figure rather than take the ones it knows (docs/AI-SORAYDI.md §3.1
 * T2): the table's totals answer wrote the kilos of «507 kg 5.9 cbm», dropped
 * the cube and put a 👍 on the message. What a figure MEANS is still
 * `parseGoodsLine`'s to say; this only says where each one stands.
 */
export function amountsIn(line: string): AmountSpan[] {
  const out: AmountSpan[] = [];
  for (const hit of blankNonAmounts(line).matchAll(AMOUNT)) {
    let word = hit[2] ?? null;
    let end = hit.index + hit[0].length;
    if (word && unitOf(word) === 'dona') {
      const next = COUNTER_THEN_UNIT.exec(line.slice(end));
      const nextUnit = next ? unitOf(next[1]!) : null;
      if (next && nextUnit !== null && nextUnit !== 'dona') {
        word = next[1]!;
        end += next[0].length;
      }
    }
    out.push({ start: hit.index, end, number: hit[1]!, word });
  }
  return out;
}

// ── a figure of ONE package or ONE piece (docs/AI-SORAYDI.md §3.1 T4, T6) ───
//
// «20 karobka, har biri 15 kg» is 15 kg of ONE carton; «Telefon 300 dona, har
// biri 0.2 kg» is 0.2 kg of ONE phone; «15 kg/ctn», «0.12 cbm/ctn», «4.5
// kg/шт» say so by their tail. Every reader took such a figure for the line's
// and for the shipment's (DIM-4, AB-1, dg2-4, dg3-01): one carton's 15 kg
// landed as the whole job's weight under ✅, over the model's correct 300.
// The rule, as the review ruled it (JN-7, JN-8, JS-1, JS-2):
//
//  1. a figure is per ONE when it is MARKED so — a tail («/ctn», «/箱», «/шт»,
//     «per ctn»), a mark before it («har biri», «har bir karobka», «each»,
//     «каждая», «в каждой коробке», a label with its tail «G.W./CTN»), «20 x
//     15 kg», a «dan» beside a count (never before «ortiq», «kam», «gacha»…),
//     a Russian «по» right after a count. Nothing else is: an unmarked figure
//     keeps every reading it had;
//  2. a mark with a noun says whose one («har bir dona» — a piece's). An
//     «each» without one binds to the count it stands with — the only kind
//     of count the line has; both kinds — nobody's, and nothing is multiplied
//     (JN-7's ruling: «both and no noun → nothing multiplied, asked»);
//  3. such a figure never reaches a total, nor a row's own column. The bot's
//     typed readers put it on the row's PACKING (`typedPacking`), and the
//     carton arithmetic (carton-math.ts `applyPacking`) multiplies — this file
//     never does.
//
// And a package's SIZE (T6, JS-2): a size is the PACKAGE's only when a
// package word stands next to it («karobka o‘lchami 60x40x50»), when it
// stands right beside the carton count («20 karobka 60x40x50», «60x40x50 sm
// 20 karobka»), or inside an each-clause bound to the cartons. A size right
// after the name and before any count is nobody's said — kept, asked, never
// multiplied. «A carton word somewhere on the line» is never the rule.

/** Whose one a per-one figure is. */
export type PerOneOwner = 'package' | 'piece';

/** A count of packs no unit list names — «1000 pachka», «200 пачек», «50 paket», «300 банок» — beside which a gram is one pack's. */
const PACK_WORD = /^(?:pachk|пачк|пачек|paket|пакет|упаковк|banka|банк|флакон|flakon|qop|қоп|мешок|meshok|bag|box|ctn|carton|karobk|коробк|кор)\p{L}*$/iu;
/** Is `word` a pack's count word (`PACK_WORD`) — for the typed readers that judge a gram beside it. */
export const packWord = (word: string | null | undefined): boolean => PACK_WORD.test(word ?? '');

/** A package's noun in its cases — «karobka», «karobkada», «karobkasi», «коробке», «мест», «ctn», «箱». */
const PACKAGE_NOUN = String.raw`(?:karobk|karopk|korobk|коробк|qut|кут|қут|qop|қоп|joy|жой|мест|упаковк|ctn|carton|box|кор|箱)\p{L}*`;
/** A piece's noun — «dona», «donasi», «шт», «штука», «pcs», «piece». */
const PIECE_NOUN = String.raw`(?:dona|дона)\p{L}*|шт\p{L}*|pcs?|pieces?|units?|единиц\p{L}*`;
const COUNT_NOUN = `${PACKAGE_NOUN}|${PIECE_NOUN}`;
const PACKAGE_NOUN_WORD = new RegExp(`^(?:${PACKAGE_NOUN})$`, 'iu');
/** A package noun's stem anywhere in a lower-cased window — what `ONE_LEAD` needs before it is run. */
const PACKAGE_STEM = /karobk|karopk|korobk|коробк|qut|кут|қут|qop|қоп|joy|жой|мест|упаковк|ctn|carton|box|кор|箱/u;
const PIECE_NOUN_WORD = new RegExp(`^(?:${PIECE_NOUN})$`, 'iu');

/** Whose one a noun names — null: it names neither. */
function nounOwner(word: string | undefined): PerOneOwner | null {
  if (!word) return null;
  if (PACKAGE_NOUN_WORD.test(word)) return 'package';
  return PIECE_NOUN_WORD.test(word) ? 'piece' : null;
}

/** A measure's word after the noun — «har bir karobka og‘irligi 15 kg», «каждое место вес 15 кг». */
const MEASURE_AFTER_NOUN = String.raw`(?:\s+(?:og[‘'’ʻ]?irlig?i|vazni|hajmi|soni|вес|объ[её]м))?`;
/** What may stand between a mark and its figure — «1 karobka = 15 kg», «1ctn=15kg» included (review owner-1). */
const MARK_GAP = String.raw`[\s,:：=＝–-]*$`;

/**
 * «har biri», «har birida», «har bir karobka(da)», «har karobkada», «har bir
 * dona», «each», «each carton», «каждая», «каждое место», «в каждой коробке»
 * — closing the text before a figure. Groups 1-4: the noun, when one stands
 * after the mark. The Russian «в» belongs to the mark: left out, it stood
 * alone in the tail and the whole goods line vanished (review owner-2, crit-3).
 */
const EACH_LEAD = new RegExp(
  String.raw`(?<![\p{L}])(?:(?:har|ҳар|хар)\s+(?:(?:bir|бир)(?:ining|ida|iga|i|ининг|ида|ига|и)?|(?:bitta|битта)(?:sida|siga|si|сида|сига|си)?)(?:\s+(${COUNT_NOUN}))?|(?:har|ҳар|хар)\s+(${COUNT_NOUN})|(?:each|every)(?:\s+(${COUNT_NOUN}))?|(?:в\s+)?кажд(?:ая|ый|ое|ую|ого|ой|ом)(?:\s+(${COUNT_NOUN}))?)${MEASURE_AFTER_NOUN}${MARK_GAP}`,
  'iu',
);
/**
 * ONE package before a figure — «bitta karobka 15 kg», «1 karobkada 24 dona»,
 * «одного места 15 кг» (group 1: a mark only beside ANOTHER carton count —
 * alone, «Stul 1 karobka 15 kg» is one carton of 15 kg, read as it always
 * was), or «в каждой коробке», «в одной коробке», «в 1 коробке» (group 2:
 * always one package's). Group 3: the noun.
 *
 * The «1» takes the Uzbek counter — «1 ta karobka», «1 та қути», the
 * commonest way a seller writes it — and may touch its noun: «1ctn=15kg»,
 * «1箱 15kg» (review owner-1: each was the shipment's 15 kg under ✅). A
 * word numeral still needs its space — «biroz», «onex» are no marks.
 */
const ONE_LEAD = new RegExp(
  String.raw`(?<![\p{L}\d.,])(?:(1(?:\s*(?:ta|та)(?=\s))?\s*|(?:bitta|битта|bir|бир|one|одн(?:ого|ой|ом|а|о|у))\s+)|(в\s+(?:1|одн(?:ой|ом)|кажд(?:ой|ом))\s+))(${PACKAGE_NOUN})${MEASURE_AFTER_NOUN}${MARK_GAP}`,
  'iu',
);
/** «в коробке по 24 шт» — what one box holds (review JN-8 (b): a bare «в коробке» describes the product, «Кукла в коробке»). */
const IN_BOX_PO = new RegExp(String.raw`(?<![\p{L}])в\s+(?:${PACKAGE_NOUN})\s+по\s*$`, 'iu');
/** «20 коробок по 15 кг», «300 шт по 0.2 кг» — a Russian «по» right after a count (group 2: that count's word). */
const PO_LEAD = /(?<![\p{L}\d.,])(\d[\d.,]*)\s*(\p{L}+)\s+по\s*$/iu;
/**
 * A weight's bare word, a label ONLY with its per-package tail — «Weight per
 * carton: 15 kg» (the comment below names it, and it was the shipment's 15
 * kg). Never a label-first total on its own (review JN-21: «weight» alone
 * needs its unit), so it is in no list of `WEIGHT_LABELS`.
 */
const PER_LABEL_ONLY: readonly string[] = ['weight', 'wt.', 'wt'];
/**
 * A measure's LABEL with its per-package tail before a figure — «G.W./CTN:
 * 15 kg», «N.W./ctn 14 kg», «毛重/箱 15kg», «Weight per carton: 15 kg», «Вес
 * брутто на 1 место 15 кг», «Вес одного места 15 кг». Group 1: the label;
 * 2: the slash word; 3: the «per» noun; 4, 5: the package noun.
 */
const LABEL_LEAD = new RegExp(
  String.raw`(?<![\p{L}])(${labelPattern([...WEIGHT_LABELS, ...NET_LABELS, ...VOLUME_LABELS, ...FIELD_LABELS.count, ...PER_LABEL_ONLY])})\s*(?:\/\s*(\p{L}+)|(?:per|pr)\s+(${COUNT_NOUN})|(?:на|за)\s+(?:1\s+|одн\p{L}*\s+)?(${PACKAGE_NOUN})|одного\s+(${PACKAGE_NOUN}))\s*[.)]?\s*[:：=]?\s*$`,
  'iu',
);
/** A label that says WHICH weight — a netto's, or a brutto's. */
const NET_LABEL_WORD = new RegExp(`^(?:${labelPattern(NET_LABELS)})$`, 'iu');

const GROSS_LABEL_WORD = /^(?:g\.?\s?w\.?|gross(?:\s*weight)?|brutto|брутто|вес\s*брутто|毛重|总毛重)$/iu;

/** WHICH weight a weight label names — a netto's, a brutto's, or it does not say («вес», «og‘irlik»). */
export function weightLabelKind(label: string): 'gross' | 'net' | null {
  const word = label.replace(/\s+/gu, ' ').trim();
  if (NET_LABEL_WORD.test(word)) return 'net';
  return GROSS_LABEL_WORD.test(word) ? 'gross' : null;
}

/**
 * A measure's label closing the text right before a figure — «G.W.:»,
 * «毛重», «Вес брутто:», «MEAS» — none of them a unit word of its own (a
 * «cbm» before a figure is the unit reader's). A Han label may follow a Han
 * name with no space: no product's name is spelled into one.
 */
const LABEL_RIGHT_BEFORE = new RegExp(
  String.raw`(?<!(?!\p{Script=Han})\p{L})(${labelPattern(
    [...WEIGHT_LABELS, ...NET_LABELS, ...VOLUME_LABELS].filter((w) => unitOf(w) === null),
  )})\s*[.)]?\s*[:：=]?\s*$`,
  'iu',
);

/**
 * The label of a figure a TAIL marks one package's or one piece's — «G.W.: 15
 * kg/ctn», «毛重 15kg/箱», «Вес брутто: 15 кг/место» (§3.1 T12, MP-2, MP-3):
 * the tail says whose the figure is, the label which weight. Both leave the
 * name — a spec block read as one line was the product «折叠椅 毛重» with a
 * brutto nobody marked. `spaced` is the line as the marks read it.
 */
function labelBeforeTail(spaced: string, at: number): { spans: [number, number][]; kind: PerOneFigure['kind'] } {
  const from = Math.max(0, at - 32);
  const label = LABEL_RIGHT_BEFORE.exec(spaced.slice(from, at));
  if (!label) return { spans: [], kind: null };
  return { spans: [markSpan(label[0], from + label.index)], kind: weightLabelKind(label[1]!) };
}
/**
 * «20 karobka x 15 kg», «20 x 15 kg», «20*24 dona» — A of something times B
 * (group 1: A; 2: A's noun). With a carton word A is the carton count; a bare
 * A sets NO carton count (review JN-8 (c): it may be pieces).
 */
const TIMES_LEAD = new RegExp(
  String.raw`(?<![\p{L}\d.,])(\d+)(?:\s*(?:(?:ta|та)\s+)?(${COUNT_NOUN}))?\s*([xх×*])\s*$`,
  'iu',
);
/**
 * «15 kg each», «0.12 cbm each», «15 kg apiece», «15 кг каждая» — «each»
 * AFTER the figure, the way an English or Russian packing note writes it
 * (review typed-break-6). Bound like «har biri»: to the one kind of count the
 * line has. Not when a figure follows it — «300 pcs each 0.2 kg» is the
 * leading mark of the 0.2 kg, and the 300 its line's own count — and never
 * «har biri», which leads in Uzbek: «300 dona har biri 0.2 kg».
 */
const EACH_TRAIL = /^\s*(?:each|apiece|ea\.|per\s+(?:one|unit|item)|каждая|каждый|каждое|каждую)(?![\p{L}])(?![ \t]*[:–-]?[ \t]*\d)/iu;
/**
 * A measure's label a PACKAGE noun possesses, before a figure — «karobka
 * og‘irligi 22.5 kg», «вес коробки 22.5 кг», «carton weight 22.5 kg», «ctn
 * G.W. 15 kg», «箱重 15kg», «单箱体积 0.12» (review typed-break-6): ONE
 * package's. Never after a COUNT of the packages — «20 karobka og‘irligi 300
 * kg» is all twenty's — and never a plural («вес коробок», «cartons weight»).
 */
const PACKAGE_LABEL_WORDS = [
  String.raw`(?<!\d\s{0,3})(?<![\p{L}\d])(?:karobk|karopk|korobk|qut|кут|қут|qop|қоп|joy|жой)\p{L}*\s+(?:og[‘'’ʻ]?irlig?i|vazni|hajmi|brutto|netto)`,
  String.raw`(?<![\p{L}])(?:вес|объ[её]м|масса)(?:\s+(?:брутто|нетто))?\s+(?:одной\s+|1\s+)?(?:коробки|места|упаковки|ящика|мешка)`,
  String.raw`(?<![\p{L}])(?:carton|ctn|box|package|pkg|bag)\s+(?:(?:gross|net)\s+)?(?:weight|wt\.?|g\.?\s?w\.?|n\.?\s?w\.?|cbm|volume|vol\.?|meas\.?)`,
  String.raw`(?<![\p{L}])(?:weight|volume)\s+of\s+(?:(?:one|each|a|the)\s+)?(?:carton|ctn|box|package)`,
  String.raw`(?:箱重|单箱(?:毛重|净重|重量|体积)|每箱(?:毛重|净重|重量|体积))`,
];
const PACKAGE_LABEL_LEAD = new RegExp(String.raw`(${PACKAGE_LABEL_WORDS.join('|')})\s*[.)]?\s*[:：=]?\s*$`, 'iu');
/** A package-possessed label's own words, looked for before the pattern is run (`markOf`). */
const PACKAGE_LABEL_STEM = /karobk|karopk|korobk|qut|кут|қут|qop|қоп|joy|жой|коробк|мест|упаковк|ящик|мешк|carton|ctn|box|package|pkg|bag|箱/u;
/** Which weight a package-possessed label names, when it says. */
const packageLabelKind = (label: string): PerOneFigure['kind'] =>
  /(?<![\p{L}])(?:net|netto|нетто|n\.\s?w\.?|nw)(?![\p{L}])|净重/iu.test(label)
    ? 'net'
    : /(?<![\p{L}])(?:gross|brutto|брутто|g\.\s?w\.?|gw)(?![\p{L}])|毛重/iu.test(label)
      ? 'gross'
      : null;
/** An uncounted package noun closing the text before a measure's label — «…, karobka» of «karobka og‘irligi 22.5 kg». */
const PACKAGE_NOUN_CLOSING = new RegExp(
  String.raw`(?<!\d\s{0,3})(?<![\p{L}\d])(?:karobk|karopk|korobk|qut|кут|қут|qop|қоп|joy|жой|carton|ctn|box)\p{L}*\s+$`,
  'iu',
);
/**
 * Does a package's noun possess the label that starts at the end of `before`
 * («karobka og‘irligi 22.5 kg» — one carton's weight)? Then the label is the
 * kernel's MARK, not the row's field: a field reader leaves it standing.
 */
export const packagePossessesLabel = (before: string): boolean => PACKAGE_NOUN_CLOSING.test(before.slice(-40));

/** «15 kg per ctn», «0.2 kg per pc» — the noun after «per» says whose. */
const PER_TRAIL = new RegExp(String.raw`^\s+(?:per|pr)\s+(${COUNT_NOUN})(?![\p{L}])`, 'iu');
/** «24 шт в каждой коробке», «24 шт в одной коробке». */
const IN_EACH_TRAIL = new RegExp(String.raw`^\s+в\s+(?:1|одн(?:ой|ом)|кажд(?:ой|ом))\s+(?:${PACKAGE_NOUN})(?![\p{L}])`, 'iu');
/** «15 kg dan» — «each» in Uzbek, beside a count (review JN-8 (a)). */
const DAN_TRAIL = /^\s*[-–]?\s*(?:dan|дан)(?![\p{L}\d])/iu;
/**
 * …and never before what makes it «from», «than» or «of»: «500 kg dan
 * ortiq», «100 kg dan boshlab», «20 kg dan 30 kg gacha» (a range's own
 * «from»), «300 kg dan oshmaydi», «5 kub dan katta emas», «300 kg dan iborat»
 * (review typed-break-7: the seller's only weight was taken for one
 * carton's, and asked again).
 */
const DAN_NOT =
  /^\s*(?:\d[\d.,]*\s*[\p{L}²³]*\s+)?(?:ortiq\p{L}*|kam\p{L}*|ko[‘'’ʻ`]?p\p{L}*|osh\p{L}*|ziyod\p{L}*|katta\p{L}*|kichik\p{L}*|iborat\p{L}*|past\p{L}*|baland\p{L}*|yengil\p{L}*|og[‘'’ʻ`]?ir\p{L}*|gacha|boshlab|yuqori\p{L}*|ортиқ\p{L}*|кам\p{L}*|кўп\p{L}*|ош\p{L}*|зиёд\p{L}*|катта\p{L}*|кичик\p{L}*|иборат\p{L}*|паст\p{L}*|баланд\p{L}*|гача|бошлаб)(?![\p{L}])/iu;
/** A totals word in the clause before a «dan» figure — «jami 300 kg dan»: the shipment's, never one carton's. */
const TOTAL_IN_CLAUSE = /(?:^|[\s,;:(])(?:jami|жами|umumiy|умумий|hammasi|ҳаммаси|итого|всего|total|yuk\p{L}*|юк\p{L}*)(?![\p{L}])[^,;\n]*$/iu;
/**
 * «15 kg/kor», «150 kg/m3», «180 gr/m2» — a kilo or a cube glued to a slash
 * and a word no tail knows: never a total (review JN-8 (e)), and nobody's
 * figure either. A RATE («180 gr/m2», per a unit of measure) stays in the
 * NAME as the seller wrote it — the coder reads it there; per anything else
 * («15 kg/kor») the figure goes on the row's note (`markOf`).
 */
const SLASH_WORD = /^\/(?=\p{L})/u;
/** The slash and its word — «/kor», «/коробке», «/m2». */
const SLASH_TAIL = /^\/([\p{L}][\p{L}\d²³.]*)/u;
/** A rate's denominator — a unit of measure, never a package or a piece: «/m2», «/m3», «/kg», «/m», «/metr», «/пм». */
const rateWord = (word: string): boolean => {
  const unit = unitOf(word);
  if (unit !== null) return unit !== 'karobka' && unit !== 'dona';
  return /^(?:m|м|metr\p{L}*|метр\p{L}*|sm|см|mm|мм|km|км|pm|пм|п\.?м\.?|soat|час|h)$/iu.test(word);
};

/** The joiner of «20x24 dona» — blanked for the reading, so «24 dona» is a figure and «20 240» never one number. */
const TIMES_JOINER = /(?<=\d)\s*[xх×*]\s*(?=\d)/gu;

/** The size words of a typed line — «o‘lchami», «razmeri», «размер», «size» (units.ts `FIELD_LABELS`). */
const SIZE_LABEL_BEFORE = new RegExp(String.raw`(?<![\p{L}])(?:${labelPattern(FIELD_LABELS.size)})\s*[.:：=]?\s*$`, 'iu');
const PACKAGE_SIZE_BEFORE = new RegExp(
  String.raw`(?<![\p{L}])(?:${labelPattern(FIELD_LABELS.packageSize)}|(?:${PACKAGE_NOUN})\s+(?:${labelPattern(FIELD_LABELS.size)}))\s*[.:：=]?\s*$`,
  'iu',
);
const PACKAGE_NOUN_AFTER = new RegExp(String.raw`^\s*(?:${PACKAGE_NOUN})(?![\p{L}\d])`, 'iu');

/** One figure of a line that is ONE package's or ONE piece's. */
export interface PerOneFigure {
  /** `[start, end)` of the figure — its number and its unit word. */
  start: number;
  end: number;
  unit: 'dona' | 'kg' | 'm3' | 'juft' | 'm2' | 'litr';
  /**
   * In the unit's own scale — a tonne's figure in kilos. Null: a number with
   * two readings («har biri 1,200 kg») — one package's all the same, so no
   * total and no column takes it; nobody multiplies a figure nobody can read.
   */
  value: number | null;
  /** Whose one — null: nobody's said, nothing is multiplied from it. */
  owner: PerOneOwner | null;
  /** A per-package weight's kind, when its label said. */
  kind: 'gross' | 'net' | null;
  /** «180 gr/m2»: a rate, kept in the name as written. */
  inName: boolean;
  /** As the seller wrote it, mark included — «har biri 15 kg». */
  text: string;
  /** The unit word as written — «kg», «cbm», «tonna». */
  word: string;
  /**
   * «20 x 15 kg» with no carton word: nobody's one (owner null), kept on the
   * row's note as written — its 20 is nobody's count (review JN-8 (c)) and its
   * 15 no carton's figure (typed-spec-4); lost from the row, nothing else would
   * say it.
   */
  noted?: true;
}

/** What a typed line states per package — `packingRead`. */
export interface PackingRead {
  figures: PerOneFigure[];
  /** The line's ONE carton count — null: none, or two that differ. */
  cartons: number | null;
  /** The ONE package size of the line, taken onto the packing (a carton count stands on the line). */
  size: (BareSize & { of: SizeOwner | null }) | null;
  /**
   * `[start, end)` the line's name gives up — the per-one figures, their
   * marks, a times multiplier, a taken size and its label — merged, in order.
   */
  consumed: [number, number][];
  /** `[start, end)` of the rates kept IN the name («180 gr/m2»): read by no figure reader, cut from nothing. */
  unread: [number, number][];
  /** The line counts pieces of its own (a count no mark makes one piece's or one package's). */
  piecesCounted: boolean;
}

interface FigureHit {
  start: number;
  end: number;
  unit: PerOneFigure['unit'] | 'karobka';
  value: number | null;
  word: string;
}

/** Spans sorted and joined where they touch or overlap — a cut applied twice cuts the wrong text. */
function mergeSpans(spans: readonly [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [s, e] of [...spans].filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

interface Mark {
  /** Fixed by the mark — or null, to be bound to a count (`each`, `dan`). */
  owner: PerOneOwner | null;
  bind: boolean;
  /**
   * The mark says what a CONTAINER holds — «har birida», «har bir karobkada»,
   * «в каждой коробке»: a count after it is one package's even with no carton
   * count on the line. «har biri 300 dona» (each one IS) is not: beside no
   * carton count it is the line's own count, as it always was.
   */
  container?: true;
  kind: PerOneFigure['kind'];
  inName: boolean;
  spans: [number, number][];
  /** «dan» marks only beside a count; «1 karobka» only beside ANOTHER carton count. */
  cond?: 'dan' | 'another_carton';
  /** The carton figure a «1 karobka» mark is made of — not the line's carton count when the mark stands. */
  cartonHit?: number;
  /** A mark that opens a clause the next figures continue («har biri 15 kg 0.12 kub»). */
  clause: boolean;
  /** «20 x 15 kg» — a bare multiplier (`PerOneFigure.noted`). */
  noted?: true;
}

const TRACKED: ReadonlySet<string> = new Set(['dona', 'kg', 'm3', 'juft', 'm2', 'litr', 'karobka']);
const PER_ONE_WINDOW = 64;

/** The words a mark ends with, its separators trimmed — the span the name gives up. */
const markSpan = (whole: string, at: number): [number, number] => [at, at + whole.replace(/[\s,:：–-]*$/u, '').length];

function figureHits(text: string, scan: string, scaled: boolean): FigureHit[] {
  const out: FigureHit[] = [];
  for (const hit of scan.matchAll(AMOUNT)) {
    let word = hit[2] ?? null;
    let end = hit.index + hit[0].length;
    if (!word) continue;
    if (unitOf(word) === 'dona') {
      const next = COUNTER_THEN_UNIT.exec(text.slice(end, end + 24));
      const nextUnit = next ? unitOf(next[1]!) : null;
      if (next && nextUnit !== null && nextUnit !== 'dona') {
        word = next[1]!;
        end += next[0].length;
      }
    }
    const scale = scaled ? scaledKg(word) : null;
    const unit = unitOf(word) ?? (scale && !scale.lone ? 'kg' : null);
    if (unit === null || !TRACKED.has(unit)) continue;
    const read = readAmountText(hit[1]!);
    if (read.state === 'bad') continue;
    const own = read.state === 'ok' ? read.value : null;
    const value = own !== null && unitOf(word) === null && scale ? scaledKgValue(own, scale.factor) : own;
    out.push({ start: hit.index, end, unit: unit as FigureHit['unit'], value, word });
  }
  return out;
}

/** The slash word's owner — a known package tail, a known piece tail, or neither. */
function tailWordOwner(word: string): PerOneOwner | null {
  const tail = `/${word.toLowerCase()}`;
  if (PER_PACKAGE_TAIL.includes(tail)) return 'package';
  return PER_PIECE_TAIL.includes(tail) ? 'piece' : null;
}

function markOf(text: string, spaced: string, hit: FigureHit, hits: readonly FigureHit[]): Mark | null {
  const after = text.slice(hit.end, hit.end + 32);
  const fixed = (owner: PerOneOwner | null, spans: [number, number][], extra: Partial<Mark> = {}): Mark => ({
    owner,
    bind: false,
    kind: null,
    inName: false,
    spans,
    clause: false,
    ...extra,
  });
  // A tail after the figure says whose — the strongest mark there is. The
  // measure's label right before such a figure says which weight, and is no
  // word of the name (`labelBeforeTail`).
  const pkg = tailAt(after, 0, PER_PACKAGE_TAIL);
  const piece = pkg > 0 ? 0 : tailAt(after, 0, PER_PIECE_TAIL);
  if (pkg > 0 || piece > 0) {
    const label = labelBeforeTail(spaced, hit.start);
    return fixed(pkg > 0 ? 'package' : 'piece', [[hit.end, hit.end + pkg + piece], ...label.spans], { kind: label.kind });
  }
  const per = PER_TRAIL.exec(after);
  if (per) return fixed(nounOwner(per[1]), [[hit.end, hit.end + per[0].length]]);
  const inEach = IN_EACH_TRAIL.exec(after);
  if (inEach) return fixed('package', [[hit.end, hit.end + inEach[0].length]]);
  const eachAfter = EACH_TRAIL.exec(after);
  if (eachAfter) return { ...fixed(null, [[hit.end, hit.end + eachAfter[0].length]]), bind: true };
  const slash = (hit.unit === 'kg' || hit.unit === 'm3') && SLASH_WORD.test(after) ? SLASH_TAIL.exec(after) : null;
  if (slash) {
    // A RATE — per a unit of measure («180 gr/m2», «150 kg/m3», «2 kg/m»): the
    // product's spec, kept in its name as written.
    if (rateWord(slash[1]!)) return fixed(null, [], { inName: true });
    // Per anything else — «15 kg/kor», «15 кг/коробке» — the figure is one of
    // something no tail names: never a total (JN-8 (e)), never a column, and
    // never a word of the name either — the row keeps its name and its other
    // figures, and this one goes on its note as written (T8, review typed-spec-2).
    return fixed(null, [[hit.end, hit.end + slash[0].length]]);
  }

  const from = Math.max(0, hit.start - PER_ONE_WINDOW);
  const before = spaced.slice(from, hit.start);
  // The marks' own words, looked for before their patterns are run: most
  // figures have none, and a pattern anchored at the window's end is tried
  // from every position of it.
  const lower = before.toLowerCase();
  const labelHit = /[/]|per|pr|на|за|одного/u.test(lower) ? LABEL_LEAD.exec(before) : null;
  // A label word right after a number is that number's UNIT, and its tail
  // that number's — «0.12 cbm/ctn 300 kg» is one carton's cube and the line's
  // own 300 kg, never a «CBM/CTN:» heading the kilos (review doors-1: the row
  // weighed 20 × 300 = 6 000 kg, a 20× weight on a per-kg customs price).
  const label = labelHit && !/\d\s*$/u.test(before.slice(0, labelHit.index)) ? labelHit : null;
  if (label) {
    const owner = label[2] !== undefined ? tailWordOwner(label[2]) : label[3] !== undefined ? nounOwner(label[3]) : 'package';
    const word = label[1]!.replace(/\s+/gu, ' ').trim();
    const kind = NET_LABEL_WORD.test(word) ? 'net' : GROSS_LABEL_WORD.test(word) ? 'gross' : null;
    // An unknown slash word — «Вес/мешок» — marks the figure as nobody's total and nobody's column.
    if (owner === null && label[2] !== undefined) return fixed(null, [], { inName: true });
    // «на 1 место» inside the label is the mark's own «1», no carton count of the line.
    const at = from + label.index;
    const cartonHit = hits.findIndex((h) => h.unit === 'karobka' && h.start >= at && h.end <= at + label[0].length);
    return fixed(owner, [markSpan(label[0], at)], { kind, clause: owner === 'package', ...(cartonHit >= 0 ? { cartonHit } : {}) });
  }
  const pkgLabel = PACKAGE_LABEL_STEM.test(lower) ? PACKAGE_LABEL_LEAD.exec(before) : null;
  if (pkgLabel) {
    return fixed('package', [markSpan(pkgLabel[0], from + pkgLabel.index)], { kind: packageLabelKind(pkgLabel[1]!), clause: true });
  }
  // «20 x 15 kg» — read off the text as written: the joiner is blanked in the scan.
  const raw = text.slice(from, hit.start);
  const times = /[xх×*]\s*$/iu.test(raw) ? TIMES_LEAD.exec(raw) : null;
  if (times) {
    const at = from + times.index;
    const joiner = at + times[0].lastIndexOf(times[3]!);
    const noun = nounOwner(times[2]);
    // A carton word: A is the carton count, read where it stands; bare, A is no
    // count of anything (JN-8 (c)) — and so B is nobody's one: «Stul 20 x 24
    // dona» may be 20 cartons of 24 or 20 of something else, and B kept as one
    // CARTON's figure was a claim the line never made (review typed-spec-4).
    // Kept on the note as written, multiplied by nothing.
    const spans: [number, number][] = [[times[2] !== undefined ? joiner : at, joiner + 1]];
    return fixed(times[2] !== undefined ? (noun ?? 'package') : null, spans, times[2] === undefined ? { noted: true } : {});
  }
  const each = /har|ҳар|хар|each|every|кажд/u.test(lower) ? EACH_LEAD.exec(before) : null;
  if (each) {
    const noun = each[1] ?? each[2] ?? each[3] ?? each[4];
    const owner = nounOwner(noun);
    // «har birida», «har bittasida», «har bir karobkada» — the locative: IN each.
    const container = /(?:da|да)$/iu.test(each[0].replace(/[\s,:：–-]*$/u, '')) || owner === 'package';
    return {
      ...fixed(owner, [markSpan(each[0], from + each.index)]),
      bind: noun === undefined,
      clause: true,
      ...(container ? { container: true as const } : {}),
    };
  }
  const one = PACKAGE_STEM.test(lower) ? ONE_LEAD.exec(before) : null;
  if (one) {
    const at = from + one.index;
    const cartonHit = hits.findIndex((h) => h.unit === 'karobka' && h.start === at);
    return fixed('package', [markSpan(one[0], at)], {
      clause: true,
      ...(one[1] !== undefined ? { cond: 'another_carton' as const, ...(cartonHit >= 0 ? { cartonHit } : {}) } : {}),
    });
  }
  const box = lower.includes('по') ? IN_BOX_PO.exec(before) : null;
  if (box) return fixed('package', [markSpan(box[0], from + box.index)], { clause: true });
  const po = lower.includes('по') ? PO_LEAD.exec(before) : null;
  if (po) {
    const unit = unitOf(po[2]);
    const owner = unit === 'karobka' ? 'package' : unit === 'dona' ? 'piece' : null;
    if (owner !== null) {
      const at = from + po.index + po[0].lastIndexOf('по');
      return fixed(owner, [[at, at + 2]], { clause: owner === 'package' });
    }
  }
  const dan = DAN_TRAIL.exec(after);
  if (dan && !DAN_NOT.test(after.slice(dan[0].length)) && !TOTAL_IN_CLAUSE.test(before)) {
    return { ...fixed(null, [[hit.end, hit.end + dan[0].length]]), bind: true, cond: 'dan' };
  }
  return null;
}

/**
 * What ONE typed line states per package and per piece, and its package's
 * size — the rule above, read off the text, multiplying nothing. Pure, and
 * linear in the line: every mark is looked for in a bounded window beside its
 * figure. `scaled`: a tonne's and a gram's figures are kilos (T14).
 */
export function packingRead(
  text: string,
  opts: {
    scaled?: boolean;
    /**
     * Another line of the same text counts the cartons (`perOneIn`): «Stul 20
     * karobka⏎1 karobka 15 kg» — a line OPENING with «1 karobka» is then one
     * carton's figure, as it is beside a count on its own line (typed-break-6).
     */
    cartonsElsewhere?: boolean;
  } = {},
): PackingRead {
  const scan = blankNonAmounts(text).replace(TIMES_JOINER, (m) => BLANK.repeat(m.length));
  // What a mark may be looked for over: a blanked size between a mark and its
  // figure is no word of either («har biri 60x40x50 sm 15 kg»).
  const spaced = scan.replace(/\uE000/gu, ' ');
  const hits = figureHits(text, scan, opts.scaled === true);
  const marks = hits.map((hit) => (hit.unit === 'karobka' ? null : markOf(text, spaced, hit, hits)));
  const cartonHits = hits.flatMap((h, i) => (h.unit === 'karobka' ? [i] : []));

  // «1 karobka 15 kg» is a mark only beside ANOTHER carton count; alone it is the count.
  marks.forEach((m, i) => {
    if (m?.cond !== 'another_carton') return;
    const others = cartonHits.length - (m.cartonHit !== undefined ? 1 : 0);
    const opensLine = opts.cartonsElsewhere === true && text.slice(0, Math.min(...m.spans.map(([a]) => a))).trim() === '';
    if (others === 0 && !opensLine) marks[i] = null;
  });
  const oneHits = new Set(marks.flatMap((m) => (m?.cartonHit !== undefined ? [m.cartonHit] : [])));
  const cartonCounts = cartonHits.filter((c) => !oneHits.has(c));
  const unmarkedPieces = hits.flatMap((h, i) => (h.unit === 'dona' && (marks[i] === null || marks[i]!.cond === 'dan') ? [i] : []));
  // «dan» marks only beside a count of the line — another than the figure itself.
  const unmarked = new Set(unmarkedPieces);
  marks.forEach((m, i) => {
    if (m?.cond !== 'dan') return;
    if (cartonCounts.length === 0 && unmarked.size - (unmarked.has(i) ? 1 : 0) === 0) marks[i] = null;
  });
  // An each-COUNT beside no carton count holds nothing — «Kurtka va shim, har
  // biri 300 dona» is each product's 300 — unless its mark names a container.
  marks.forEach((m, i) => {
    const unit = hits[i]!.unit;
    if (!m?.bind || unit === 'kg' || unit === 'm3' || m.container || cartonCounts.length > 0) return;
    marks[i] = null;
  });
  const pieceCounts = hits.flatMap((h, i) => (h.unit === 'dona' && marks[i] === null ? [i] : []));
  const counts = [
    ...cartonCounts.map((i) => ({ at: hits[i]!.start, owner: 'package' as const })),
    ...pieceCounts.map((i) => ({ at: hits[i]!.start, owner: 'piece' as const })),
  ].sort((a, b) => a.at - b.at);
  const kinds = new Set(counts.map((c) => c.owner));
  /**
   * The count an «each» stands with (rule 2): the ONE kind of count the line
   * has. Both kinds and no noun after the mark — nobody's, and nothing is
   * multiplied (review JN-7, ruled = JS-1): «Stul 100 dona 20 karobka, har
   * biri 2 kg» is a chair's 2 kg (200 kg) and «Kurtka 300 dona, 20 karobka,
   * har biri 15 kg» a carton's 15 kg (300 kg) — one shape, two truths, and
   * the nearest count before the mark (JS-1's proposal) was wrong for the
   * first with no question (review typed-spec-1). Only the seller can say.
   */
  const boundOwner = (): PerOneOwner | null => {
    if (kinds.size === 2) return null;
    return kinds.size === 1 ? [...kinds][0]! : 'package';
  };

  const figures: (PerOneFigure & { clause: boolean; mark: Mark; at: number })[] = [];
  hits.forEach((hit, i) => {
    const mark = marks[i];
    if (!mark) return;
    let owner = mark.bind ? boundOwner() : mark.owner;
    // What one package holds is a count; a piece holds no pieces — nor has a cube of its own on the packing.
    if (hit.unit !== 'kg' && owner === 'piece') owner = null;
    if (hit.unit !== 'kg' && hit.unit !== 'm3' && mark.bind) owner = 'package';
    const from = Math.min(hit.start, ...mark.spans.map(([s]) => s));
    const to = Math.max(hit.end, ...mark.spans.map(([, e]) => e));
    figures.push({
      start: hit.start,
      end: hit.end,
      unit: hit.unit as PerOneFigure['unit'],
      value: hit.value,
      owner,
      kind: hit.unit === 'kg' ? mark.kind : null,
      inName: mark.inName,
      text: text.slice(from, to).replace(/\s+/gu, ' ').trim(),
      word: hit.word,
      ...(mark.noted ? { noted: true as const } : {}),
      // A clause nobody's owner could be said for goes on as nobody's: «…, har
      // biri 2 kg 0.05 kub» beside both counts states neither for the line.
      clause: mark.clause && (owner === 'package' || (mark.bind && owner === null && kinds.size === 2)),
      mark,
      at: i,
    });
  });
  // A clause bound to the cartons goes on over the next figures of its
  // segment: «har biri 15 kg 0.12 kub» — both one carton's. Never past a
  // comma, a count, or another mark; never a piece's clause, whose figures
  // after it are the line's own («300 dona har biri 0.2 kg 5 kub»).
  const segmentEnd = (at: number) => {
    // A clause is a few words long: the window bounds the look on a long pasted line.
    const stop = text.slice(at, at + 160).search(/[,;\n]/u);
    return stop < 0 ? at + 160 : at + stop;
  };
  for (const clause of figures.filter((f) => f.clause)) {
    const stop = segmentEnd(clause.end);
    for (let i = clause.at + 1; i < hits.length; i += 1) {
      const hit = hits[i]!;
      if (hit.start >= stop || hit.unit === 'karobka' || hit.unit === 'dona' || marks[i] !== null) break;
      figures.push({
        start: hit.start,
        end: hit.end,
        unit: hit.unit,
        value: hit.value,
        owner: clause.owner,
        kind: null,
        inName: false,
        text: text.slice(hit.start, hit.end).replace(/\s+/gu, ' ').trim(),
        word: hit.word,
        clause: false,
        mark: { ...clause.mark, spans: [] },
        at: i,
      });
      marks[i] = clause.mark;
    }
  }
  figures.sort((a, b) => a.start - b.start);

  const values = new Set(cartonCounts.map((i) => hits[i]!.value));
  const cartons = values.size === 1 ? wholeCartons([...values][0]) : null;
  const consumed: [number, number][] = figures
    .filter((f) => !f.inName)
    .flatMap((f) => [[f.start, f.end] as [number, number], ...f.mark.spans]);
  const size = cartons !== null ? packageSize(text, hits, cartonCounts, figures, boundOwner) : null;
  if (size) consumed.push(...size.spans);
  return {
    figures: figures.map(({ clause: _clause, mark: _mark, at: _at, ...f }) => f),
    cartons,
    size: size?.size ?? null,
    consumed: mergeSpans(consumed),
    unread: figures.filter((f) => f.inName).map((f) => [f.start, f.end] as [number, number]),
    piecesCounted: pieceCounts.length > 0,
  };
}

/**
 * The line's ONE package size and whose it is (T6, JS-2) — read only where a
 * carton count stands on the line: without one a size stays in the name, as
 * it always did («Stol 120x80x100 sm 5 dona»). Two sizes: nothing is taken.
 */
function packageSize(
  text: string,
  hits: readonly FigureHit[],
  cartonCounts: readonly number[],
  figures: readonly (PerOneFigure & { clause: boolean })[],
  boundOwner: () => PerOneOwner | null,
): { size: BareSize & { of: SizeOwner | null }; spans: [number, number][] } | null {
  const tokens: { start: number; end: number; size: BareSize }[] = [];
  let scan = text;
  for (let round = 0; round < 40; round += 1) {
    const token = parseSize(scan);
    if (!token) break;
    if (token.size) tokens.push({ start: token.start, end: token.end, size: token.size });
    scan = blankSpan(scan, token.start, token.end);
  }
  if (tokens.length !== 1) return null;
  const token = tokens[0]!;
  const from = Math.max(0, token.start - 48);
  const before = text.slice(from, token.start);
  const spans: [number, number][] = [[token.start, token.end]];
  // A label's span stops where a carton count ends — «20 karobka razmeri
  // 60x40x50»: «karobka» is the count's word, and the count keeps it.
  const labelSpan = (whole: string, at: number): [number, number] => {
    const span = markSpan(whole, at);
    const count = cartonCounts.map((i) => hits[i]!).find((h) => h.start < span[1] && h.end > span[0]);
    return count ? [Math.max(span[0], count.end), span[1]] : span;
  };
  const taken = (of: SizeOwner | null, extra: [number, number][] = []) => ({ size: { ...token.size, of }, spans: [...spans, ...extra] });

  const packageLabel = PACKAGE_SIZE_BEFORE.exec(before);
  if (packageLabel) return taken('package', [labelSpan(packageLabel[0], from + packageLabel.index)]);
  // A size word that names nobody's size — «尺寸», «Size:», «Размер», «o‘lchami»
  // — says so even right beside the carton count (review JN-11): a spec
  // block's «尺寸 60*40*50cm 20箱» may be the folding chair's own, and is asked.
  const sizeLabel = SIZE_LABEL_BEFORE.exec(before);
  if (sizeLabel) return taken(null, [labelSpan(sizeLabel[0], from + sizeLabel.index)]);
  // Right beside the carton count, with nothing but spaces between («20
  // karobka 60x40x50», «60x40x50 sm 20 ta karobka»).
  const beside = cartonCounts.some((i) => {
    const c = hits[i]!;
    const [a, b] = c.end <= token.start ? [c.end, token.start] : [token.end, c.start];
    return b - a <= 8 && /^\s*$/u.test(text.slice(a, b));
  });
  if (beside) return taken('package');
  const nounAfter = PACKAGE_NOUN_AFTER.exec(text.slice(token.end, token.end + 32));
  if (nounAfter) return taken('package', [[token.end, token.end + nounAfter[0].length]]);
  // Inside an each-clause: «har biri 60x40x50 sm 15 kg» — whose the clause is,
  // the count it stands with says, or its noun does («har bir karobka
  // 60x40x50»). A piece's each-size is the PRODUCT's own: «Stol 10 dona, 2
  // karobka, har bir dona 120x80x75» multiplies nothing by the cartons.
  const each = EACH_LEAD.exec(before);
  if (each) {
    const owner = nounOwner(each[1] ?? each[2] ?? each[3] ?? each[4]) ?? boundOwner();
    return taken(owner === 'package' ? 'package' : owner === 'piece' ? 'product' : null, [markSpan(each[0], from + each.index)]);
  }
  const one = ONE_LEAD.exec(before);
  if (one) return taken('package', [labelSpan(one[0], from + one.index)]);
  // …or after a package's clause of the same segment: «20 karobka, har biri 15 kg 60x40x50».
  const stop = text.slice(0, token.start).search(/[,;\n][^,;\n]*$/u);
  if (figures.some((f) => f.clause && f.end <= token.start && f.end > stop)) return taken('package');
  return taken(null);
}

/**
 * Every per-one figure of a text, line by line, its offsets the TEXT's: what
 * the shipment-totals reader must never take for a total (T4) — a rate kept
 * in a name («180 gr/m2») included — and what a totals answer names as one
 * package's (line-address.ts `totalsLeft`).
 */
export function perOneIn(text: string, opts: { scaled?: boolean } = {}): PerOneFigure[] {
  const out: PerOneFigure[] = [];
  const lines = text.split('\n');
  // Which lines count cartons — a line opening with «1 karobka» elsewhere is then one carton's.
  const counting = lines.map((line) => CARTON_COUNT.test(line));
  const counts = counting.filter(Boolean).length;
  let at = 0;
  lines.forEach((line, i) => {
    if (/\d/u.test(line)) {
      const cartonsElsewhere = counts - (counting[i] ? 1 : 0) > 0;
      for (const f of packingRead(line, { ...opts, cartonsElsewhere }).figures) out.push({ ...f, start: at + f.start, end: at + f.end });
    }
    at += line.length + 1;
  });
  return out;
}

/** A carton COUNT on a line — «20 karobka», «20 ta karobka», «20 ctns» — but not «1 karobka», «1ctn» (the mark itself). */
const CARTON_COUNT = new RegExp(String.raw`(?<![\p{L}\d.,])(?!1(?![\d.,]))\d+\s*(?:(?:ta|та)\s+)?(?:${PACKAGE_NOUN})(?![\p{L}])`, 'iu');

/** `[start, end)` of every per-one figure of a text (`perOneIn`). */
export const perOneSpans = (text: string, opts: { scaled?: boolean } = {}): [number, number][] =>
  perOneIn(text, opts).map((f) => [f.start, f.end]);

const PER_CARTON_UNIT: Record<'dona' | 'juft' | 'm2' | 'litr', PerCartonUnit> = { dona: 'dona', juft: 'juft', m2: 'm2', litr: 'litr' };

/**
 * The row's packing from what a typed line states (`packingRead`) — `from:
 * 'typed'`, each factor once. A factor written twice with two values is no
 * factor (nothing is multiplied from a figure the line contradicts), and a
 * figure whose owner nobody said goes ASIDE, as written, for the row's note.
 * Null when the line states nothing per package and no package size.
 */
export function typedPacking(read: PackingRead): { packing: Packing | null; aside: string[] } {
  const p: Packing = emptyPacking('typed');
  const aside: string[] = [];
  const seen = new Map<string, PerOneFigure>();
  const set = (factor: 'kgPerCarton' | 'm3PerCarton' | 'pcsPerCarton' | 'kgPerPiece', f: PerOneFigure, apply: () => void) => {
    const had = seen.get(factor);
    if (had === undefined) {
      seen.set(factor, f);
      apply();
      return;
    }
    if (had.value === f.value) return;
    aside.push(had.text, f.text);
    p[factor] = null;
    if (factor === 'pcsPerCarton') delete p.perCartonUnit;
    if (factor === 'kgPerCarton') p.kgPerCartonKind = null;
  };
  for (const f of read.figures) {
    if (f.inName) continue;
    if (f.noted) aside.push(f.text);
    if (f.owner === null || f.value === null) {
      aside.push(f.text);
    } else if (f.unit === 'kg') {
      if (f.owner === 'package') {
        set('kgPerCarton', f, () => {
          p.kgPerCarton = f.value;
          p.kgPerCartonKind = f.kind;
        });
      } else {
        set('kgPerPiece', f, () => {
          p.kgPerPiece = f.value;
        });
      }
    } else if (f.unit === 'm3') {
      set('m3PerCarton', f, () => {
        p.m3PerCarton = f.value;
      });
    } else {
      const unit = f.unit;
      set('pcsPerCarton', f, () => {
        p.pcsPerCarton = f.value;
        if (unit !== 'dona') p.perCartonUnit = PER_CARTON_UNIT[unit];
      });
    }
  }
  if (p.kgPerPiece === null) delete p.kgPerPiece;
  p.cartons = read.cartons;
  p.size = read.size;
  const stated =
    p.kgPerCarton !== null || p.m3PerCarton !== null || p.pcsPerCarton !== null || (p.kgPerPiece ?? null) !== null || p.size !== null;
  return { packing: stated ? p : null, aside: [...new Set(aside)] };
}

/** How long an ending a misspelt unit may carry — «kub-ik», «кубометр-ы», «kilo-gr», «kub-lar». */
const NEAR_ENDING = 3;

/**
 * The kilo or the cube a word that is NO unit most likely means — «kubik»,
 * «кубик», «кубометры», «kilogr» (§3.1 T3, dg3-04): a word of the vocabulary
 * with an ending on it. Only what shapes a QUESTION («“kubik” — kubmi?»);
 * nothing is ever read through it. Kilos and cubes only — the two a totals
 * question asks — and never a long tail («kilometr» is no kilo, «кубатура» is
 * a word of its own). «cum» is left out: «cumin» is a spice.
 */
export function nearUnit(word: string): 'kg' | 'm3' | null {
  const typed = normalizeWord(word);
  if (unitOf(typed) !== null) return null;
  let best: { unit: 'kg' | 'm3'; length: number } | null = null;
  for (const unit of ['kg', 'm3'] as const) {
    for (const known of WORDS[unit]) {
      const stem = normalizeWord(known);
      if (stem === 'cum' || !/^\p{L}{3,}$/u.test(stem)) continue;
      const ending = typed.length - stem.length;
      if (!typed.startsWith(stem) || ending < 1 || ending > NEAR_ENDING) continue;
      if (!best || stem.length > best.length) best = { unit, length: stem.length };
    }
  }
  return best?.unit ?? null;
}

/**
 * A word and a colon just before a bare number — «Мест: 45», «Kg：150» — the
 * field form of a unit. Two letters at least: a lone «L:» is a SIZE on a
 * clothing line («Futbolka L: 50»), never fifty litres.
 */
const UNIT_FIELD_BEFORE = /(?<![\p{L}\d])([\p{L}²³][\p{L}\d²³]+)\s*[:：]\s*$/u;

/**
 * Does a unit word before a colon name the number after it (`UNIT_FIELD_BEFORE`)?
 * Not «kv» / «кв» right after the house number of an address — «Chilonzor 12,
 * kv: 45», «ул. Навои 12, кв: 45», «дом: 12, кв: 45» — which is the FLAT,
 * never square metres (round-5 probe); after a product's own figure it still
 * is, «Kafel 12, kv: 45». And not a carton noun right after a word of the
 * name, where it is the product's own noun — «Pitsa korobka: 5000», «Lunch
 * box: 500» — while a word that only ever counts places («Мест», «CTN», «joy»)
 * or a plural («Kurtka cartons: 45») is a field wherever it stands, as is a
 * carton noun opening its clause («Karobka: 45», «Kurtka, Коробки: 45»), set
 * off by a dash («Kurtka - karobka: 45») or after a total word («Jami karobka:
 * 45»).
 *
 * A KILO or a CUBE word gets the carton nouns' test too (review JN-22): the
 * vocabulary gained «куба», and «Сигары Куба: 5» became five cubic metres of
 * cigars — after a word of the name it is the name («Куба» is Cuba there).
 * It is a field where it opens its clause («Kg: 150», «Kurtka, kub: 5»),
 * after a figure, a unit or a total word, and after its own measure's label
 * («Вес кг: 150»).
 */
function unitField(word: string, before: string): boolean {
  const unit = unitOf(word);
  if (unit === null) return false;
  if (/^(?:kv|кв)$/iu.test(word)) {
    // The house number and the one or two words that name its street or house.
    const house = before.split(/[\s,;:]+/u).filter(Boolean).slice(-3);
    return !(/\d\s*[,;]?\s*$/u.test(before) && house.slice(0, -1).some(addressWord));
  }
  if (unit !== 'karobka' && unit !== 'kg' && unit !== 'm3') return true;
  if (unit === 'karobka' && PLACES_ONLY.test(word)) return true;
  const prior = /([\p{L}\d²³.]+)[\s'’‘ʻ`]*$/u.exec(before)?.[1];
  if (prior === undefined || /\d/u.test(prior) || unitOf(prior) !== null || TOTAL_WORD.test(prior)) return true;
  // A kilo or a cube after its own measure's label — «Вес кг: 150», «Hajmi m3: 12» — is that label's unit.
  return unit !== 'karobka' && MEASURE_LABEL_BEFORE.test(before);
}
/** The carton words that only ever count places, and the plurals — never one product's noun. */
const PLACES_ONLY = /^(?:мест[оа]?|ctns?|joy|кор|boxes|cartons|коробки|коробок)$/iu;
/**
 * A total before a carton noun makes it the count: «Jami karobka», «Жами
 * коробка», «Итого коробка», «Total box» — Uzbek in both scripts and the
 * spoken «obshiy» (round-6 probe: the Cyrillic «Жами коробка: 45» became a
 * product of 45 pieces).
 */
const TOTAL_WORD = /^(?:jami|umumiy|hammasi|obshiy|жами|умумий|ҳаммаси|хаммаси|итого|всего|общее|общий|total)$/iu;

/**
 * A TNVED code as stored: digits only, 4-10 of them.
 *
 * A NUMERIC spreadsheet cell of nine digits has lost its leading zero (Excel
 * stores 0901210000 as 901210000), and a nine-digit code then longest-matches
 * an UNRELATED heading — coffee 0901 as microscopes 9011 (2026-10-09 judge,
 * measured on the seed). Such a cell is padded. Typed TEXT of nine digits is
 * not guessed: it is a problem the person resolves.
 */
export function normalizeTnved(
  raw: string | number | null | undefined,
): { code: string } | { problem: 'code_short'; text: string } | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0) return null;
    const digits = String(raw);
    if (digits.length === 9) return { code: digits.padStart(10, '0') };
    return digits.length >= 4 && digits.length <= 10 ? { code: digits } : null;
  }
  const bare = raw.replace(/[.\s ]/g, '');
  if (!/^\d{4,10}$/.test(bare)) return null;
  if (bare.length === 9) return { problem: 'code_short', text: raw.trim() };
  return { code: bare };
}

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

const hasLetters = (s: string) => /\p{L}/u.test(s);

/** How `parseGoodsLine` joins a line's columns for `packingRead`. */
const CELL_JOIN = ' ; ';

/**
 * `opts.scaled` (§3.1 T14, review JN-9 / JR-22) — the bot's typed readers ask
 * it, nobody else: a tonne or a gram, in a spelling that can be nothing else
 * («2 tonna», «20 тонн», «500 gr», «2吨»), is the line's weight in kilos.
 * NOT on a line that also states its pieces: there the figure is what ONE
 * piece is — a jack's 5 tonnes, a pack's 500 grams («Domkrat 5 tonna 20
 * dona», «chay 500 gr 2000 dona») — and it stays in the name, as «4 кубов»
 * does beside a count; and never a figure before a slash («180 gr/m2» is a
 * density). A lone «t» / «g» is never read here at all.
 *
 * `opts.packing` (§3.1 T4/T6) — the bot's typed readers ask it too: a figure
 * marked as ONE package's or ONE piece's (`packingRead`) is read into
 * `packing` and never into a column, its mark leaves the name, and a size
 * beside the carton count is the package's. Without it every door reads what
 * it always read — «15 kg/ctn» is still that line's 15 kg on the card form
 * and the VED's paste box, which have no packing to put it on (review JR-22).
 */
export function parseGoodsLine(
  raw: string,
  opts: {
    scaled?: boolean;
    packing?: boolean;
    /**
     * The caller's own words after which a grouped number is whole (`groupedReading`'s
     * `isLabel`): the bot's typed readers know a route's places, a greeting, the
     * cargo's own nouns — this file does not (intake.ts imports it).
     */
    openers?: (word: string) => boolean;
  } = {},
): GoodsLine {
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
  const delimited = /[\t;]/.test(raw) || /,(?!\d)|(?<!\d),/.test(raw);
  const cells = (/[\t;]/.test(raw) ? raw.split(/[\t;]/) : raw.split(/,(?!\d)|(?<!\d),/))
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  // A CODE column (an Excel «Код ТН ВЭД»): a cell that is only a code, in a
  // row where another cell carries the name. Taken when it is ten digits,
  // when it stands BEFORE the name, or when it stands right AFTER the name
  // in a row of three or more cells («Kurtka | 6201 | 300 | 150 kg»). A
  // two-cell «Stol; 1000» is a thousand tables.
  const nameAt = cells.findIndex(hasLetters);
  const kept: string[] = [];
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i]!;
    const code = line.tnvedCode === null && nameAt >= 0 && cells.length > 1 ? isCodeCell(cell) : null;
    if (
      code !== null &&
      (code.length === 10 || i < nameAt || (i === nameAt + 1 && cells.length >= 3))
    ) {
      const normal = normalizeTnved(cell);
      if (normal && 'code' in normal) line.tnvedCode = normal.code;
      else if (normal) line.problems.push({ kind: 'code_short', text: normal.text });
      continue;
    }
    kept.push(cell);
  }

  // A column holding ONLY a unit word belongs to the number in the column
  // before it — «Kafel plitka, 120, m2», «Krossovka\t40\tпар»: the old
  // «name, quantity, unit» shape every door has accepted.
  for (let i = kept.length - 1; i > 0; i -= 1) {
    const cell = kept[i]!;
    if (!/^\s*\d/.test(cell) && unitOf(cell) !== null && /\d\s*$/.test(kept[i - 1]!)) {
      kept[i - 1] = `${kept[i - 1]} ${cell}`;
      kept.splice(i, 1);
    }
  }

  if (line.tnvedCode === null) {
    for (let i = 0; i < kept.length; i += 1) {
      const found = codeIn(kept[i]!);
      if (found) {
        line.tnvedCode = found.code;
        kept[i] = `${kept[i]!.slice(0, found.start)} ${kept[i]!.slice(found.end)}`;
        break;
      }
    }
  }

  let unknown: { word: string; value: number } | null = null;
  const bare: { value: number; cell: number }[] = [];
  const taken = new Set<SellerUnit>();
  // The line's weight came from a tonne or a gram: «2 tonna 2000 kg» then says ONE weight in two scales.
  let weightScaled = false;
  // A grouped figure asked for both readings — «1 200 dona» — as the seller
  // wrote it, for the row's note: the row stands without it, and the figure he
  // typed must not vanish with no word (review typed-break-4).
  const groupedAside: string[] = [];
  // Has a figure with its unit been read yet (in the order the line is read)?
  // A counted cube only BEFORE the first one is inside the name run.
  let figureSeen = false;
  const nameParts: string[] = [];

  // What the line states per package (T4/T6), read over its columns as ONE
  // text — a mark finds the count it stands with in another column. Joined
  // with a «;», which no mark crosses and no number groups over.
  const cellAt: number[] = [];
  let offset = 0;
  for (const cell of kept) {
    cellAt.push(offset);
    offset += cell.length + CELL_JOIN.length;
  }
  const packed = opts.packing ? packingRead(kept.join(CELL_JOIN), { scaled: opts.scaled === true }) : null;
  /** The spans of the joined text inside each cell, as the cell's own offsets — one pass over spans in order. */
  const byCell = (spans: readonly [number, number][]): [number, number][][] => {
    const out: [number, number][][] = kept.map(() => []);
    let cell = 0;
    for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0])) {
      while (cell < kept.length - 1 && s >= cellAt[cell + 1]!) cell += 1;
      if (s >= cellAt[cell]! && e <= cellAt[cell]! + kept[cell]!.length) out[cell]!.push([s - cellAt[cell]!, e - cellAt[cell]!]);
    }
    return out;
  };
  const consumedOf = packed ? byCell(packed.consumed) : null;
  const unreadOf = packed ? byCell(packed.unread) : null;

  // «Набор 4 кубов 20 шт» — a toy's own cubes, on a line that states its
  // pieces (review JN-22): the «N кубов» stays in the name, see below. A count
  // of ONE package's pieces («har birida 24 dona») is no piece count of the line.
  const piecesStated = packed
    ? packed.piecesCounted
    : kept.some((cell) => [...cell.matchAll(AMOUNT)].some((h) => unitOf(h[2]) === 'dona'));
  // A GRAM beside any count — pieces, cartons, packs — is what one pack or one
  // piece weighs: «Choy 500 gr 200 karobka», «Kofe 250 gr, 1000 pachka» are
  // tea in half-kilo packs, never a 0.5 kg row (review typed-break-3). The
  // figure stays in the name, where the coder reads it.
  const countStated =
    piecesStated ||
    kept.some((cell) => [...blankNonAmounts(cell).matchAll(AMOUNT)].some((h) => unitOf(h[2]) === 'karobka' || PACK_WORD.test(h[2] ?? '')));

  kept.forEach((cellText, cellIndex) => {
    const consumed: [number, number][] = [];
    const cellBare: { value: number; start: number; end: number; asked: GoodsLineProblem | null }[] = [];
    // A size and a code's digits are no amounts (T0): read from the blanked
    // text, cut the name from the cell as written — the offsets are the same.
    let scan = blankNonAmounts(cellText);
    if (packed) {
      // A per-one figure, its mark, a times multiplier, a packed size and its
      // label: read by no column below, and out of the name; a rate («180
      // gr/m2») is read by nothing and stays in the name.
      scan = blankSpans(scan, [...consumedOf![cellIndex]!, ...unreadOf![cellIndex]!]);
      consumed.push(...consumedOf![cellIndex]!);
    }
    for (const hit of scan.matchAll(AMOUNT)) {
      const number = hit[1]!;
      let word = hit[2] ?? null;
      let start = hit.index!;
      let end = start + hit[0].length;
      // A space-grouped number after a name word or a bare number: its first
      // group may be a count, a model, a code — both readings, asked.
      const tail = withoutFirstGroup(number);
      const welded = tail !== null && groupedReading(scan, hit.index!, opts.openers) === 'ask';
      // «Мест: 45», «Kg: 150» — a unit word written as a FIELD before its
      // number names that number: a carton count is never 45 pieces (c0347).
      const field = word ? null : UNIT_FIELD_BEFORE.exec(cellText.slice(0, start));
      // What stands before the field word, the column before it included
      // («Chilonzor 12, kv: 45» is two columns).
      const lead = cellIndex > 0 ? `${kept[cellIndex - 1]}, ` : '';
      if (field && unitField(field[1]!, lead + cellText.slice(0, field.index))) {
        word = field[1]!;
        start = field.index;
      }
      // «120 ta juft» — a counter word followed by a unit word: the unit wins.
      if (word && unitOf(word) === 'dona') {
        const next = COUNTER_THEN_UNIT.exec(cellText.slice(end));
        const nextUnit = next ? unitOf(next[1]!) : null;
        if (next && nextUnit !== null && nextUnit !== 'dona') {
          word = next[1]!;
          end += next[0].length;
        }
      }
      const unit = word ? unitOf(word) : null;
      // «2 tonna», «500 gr» — kilos in another scale (T14), for the readers
      // that ask. Beside a piece count, or before a slash, the figure is the
      // goods' own measure and stays where it is.
      const scale = opts.scaled && word && unit === null ? scaledKg(word) : null;
      const scaled =
        scale !== null && !scale.lone && !(scale.factor < 1 ? countStated : piecesStated) && !/^\s*\//u.test(cellText.slice(end));
      // «iPhone 15 Pro», «Stul 2 xil» — a number followed by a word that is
      // not a unit belongs to the NAME. Remember it: on a line that states
      // nothing else, «Ткань 300 м» is an amount in a unit this file does not
      // price, and that is ASKED, not dropped.
      if (word && unit === null && !scaled) {
        const amount = readAmountText(number);
        if (amount.state === 'ok') unknown = { word, value: amount.value };
        continue;
      }
      // «4 кубов», «2 куба», «12 kubov» beside a piece count are what the
      // goods are made of («Набор 4 кубов 20 шт»), never four cubic metres:
      // the figure stays in the name. Alone, or on a totals line, it is m³ —
      // and so it is AFTER the line's first figure, outside the name run:
      // «Kurtka 300 dona 450 kg 5 kubov» is the trade's own way of writing the
      // cube beside the count, and folded into the name it was dropped with no
      // word (review typed-break-5, JN-22's «inside a goods line»).
      if (unit === 'm3' && piecesStated && !figureSeen && COUNTED_CUBES.has(normalizeWord(word!))) continue;
      const amount = readAmountText(number);
      if (amount.state === 'bad') continue;
      // Both readings of a doubted figure are in KILOS when its word scales it («1,200 тн»).
      const kilos = (n: number) => (scaled ? scaledKgValue(n, scale!.factor) : n);
      if (amount.state === 'ambiguous') {
        consumed.push([start, end]);
        line.problems.push({ kind: 'ambiguous', text: number, decimal: kilos(amount.decimal), thousands: kilos(amount.thousands) });
        continue;
      }
      const asked: GoodsLineProblem | null = welded
        ? { kind: 'ambiguous', text: number, decimal: kilos(tail!), thousands: kilos(amount.value), grouped: true }
        : null;
      if (!word) {
        cellBare.push({ value: amount.value, start, end, asked });
        continue;
      }
      consumed.push([start, end]);
      line.unitWords.push(word);
      if (asked) {
        // The unit is stated (the line still STATES goods); the figure is not.
        line.problems.push(asked);
        groupedAside.push(cellText.slice(start, end).replace(/\s+/gu, ' ').trim());
        continue;
      }
      figureSeen = true;
      const routed = routeAmount(amount.value, word, { scaled });
      const key = scaled ? 'kg' : unit!;
      if (taken.has(key)) {
        // «2 tonna 2000 kg» is one weight in two scales; anything else said
        // twice in one unit is asked, the same figure included (the kernel
        // says the unit was repeated, not that the figures agree).
        const sameInAnotherScale = 'weightKg' in routed && routed.weightKg === line.weightKg && scaled !== weightScaled;
        if (!sameInAnotherScale) line.problems.push({ kind: 'repeated', unit: key });
        continue;
      }
      taken.add(key);
      if (scaled) weightScaled = true;
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
    // In ONE free-text cell, only the LAST bare number can be the count
    // («Stul 2 21» keeps «2» in the name). Across cells every bare number is
    // a candidate — decided below.
    const last = cellBare.at(-1);
    if (last) {
      // «Stul 20 300», «iPhone 15 128»: the count itself may be welded.
      if (last.asked) {
        line.problems.push(last.asked);
        groupedAside.push(cellText.slice(last.start, last.end).replace(/\s+/gu, ' ').trim());
      } else bare.push({ value: last.value, cell: cellIndex });
      consumed.push([last.start, last.end]);
    }
    let rest = cellText;
    for (const [s0, e0] of consumed.sort((a, b) => b[0] - a[0])) {
      rest = `${rest.slice(0, s0)} ${rest.slice(e0)}`;
    }
    if (rest.trim()) nameParts.push(rest);
  });

  // The COUNT. One bare number: «nomi, soni», the convention every door has
  // always had. Two or more in separate columns with no unit: refused — a
  // headerless «Kurtka; 300; 150» is a count and a weight in SOME order.
  if (line.quantity === null && bare.length === 1) {
    line.quantity = bare[0]!.value;
  } else if (line.quantity === null && bare.length > 1) {
    if (delimited && new Set(bare.map((b) => b.cell)).size > 1) {
      line.problems.push({ kind: 'unlabelled', values: bare.map((b) => b.value) });
    } else {
      line.quantity = bare.at(-1)!.value;
    }
  }

  line.name = nameParts.join(' ').replace(/[\s,;:]+/gu, ' ').trim();

  const statesNothing =
    line.quantity === null &&
    line.weightKg === null &&
    line.volumeM3 === null &&
    line.measureQty === null &&
    line.cartons === null;
  if (statesNothing && unknown !== null && !line.problems.some((p) => p.kind === 'unlabelled')) {
    const u = unknown as { word: string; value: number };
    line.problems.push({ kind: 'unknown_unit', word: u.word.slice(0, 20), value: u.value });
  }
  if (packed) {
    const { packing, aside } = typedPacking(packed);
    line.packing = packing;
    line.aside = aside;
    line.perOne = packed.figures.map((f) => f.text);
    // The unit is stated, whosever the figure: the line still states goods.
    line.unitWords.push(...packed.figures.filter((f) => !f.inName).map((f) => f.word));
  }
  if (groupedAside.length > 0) line.aside = [...(line.aside ?? []), ...groupedAside];
  if (line.cartons !== null && line.quantity === null && line.weightKg === null && line.measureQty === null) {
    line.problems.push({ kind: 'cartons_only', cartons: line.cartons });
  }
  return line;
}

/**
 * ONE rule for «this row's number is in the wrong column» — the door
 * (`openCalcRequest`) and the old-row heal (the measure pass) both call it,
 * so the two can never disagree about a collision (#513; spec judge S7).
 *
 * A row's `quantity` is read as PIECES by the engine whatever `unit` says.
 * When `unit` names another column, the number MOVES there and `quantity` is
 * cleared — even when the target is already filled, because leaving 500 in
 * the piece column under a «kg» word prices 500 pieces (judge MR-5); the
 * conflicting figure goes into the note. A carton count or an unknown word
 * clears the piece column and writes the note: the line now owes its count.
 *
 * After a move `unit` is set to null and the seller's original words live in
 * the note («sotuvchi: 120 m2»), so the rule can never fire twice on one row
 * — a VED who later types a real count into the piece column is never
 * «healed» back into kilograms (judge MR-4).
 */
export interface RowUnitInput {
  quantity: number | null;
  unit: string | null;
  weightKg: number | null;
  volumeM3: number | null;
  measureUnit: MeasureUnit | null;
  measureQty: number | null;
}

export interface RowUnitPatch {
  quantity: number | null;
  unit: string | null;
  weightKg: number | null;
  volumeM3: number | null;
  measureUnit: MeasureUnit | null;
  measureQty: number | null;
}

export type RowUnitResult =
  | { moved: false }
  | {
      moved: true;
      patch: RowUnitPatch;
      /** Where the number went — `cartons`/`unknown` went nowhere. */
      to: 'kg' | 'm3' | MeasureUnit | 'cartons' | 'unknown';
      /** «sotuvchi: 120 m2» — appended to the row's note by the caller. */
      note: string;
      /** The target held a DIFFERENT figure already; both are in the note. */
      conflict: boolean;
    };

export function normalizeRowUnit(row: RowUnitInput): RowUnitResult {
  if (row.quantity === null || !row.unit || !row.unit.trim()) return { moved: false };
  const routed = routeAmount(row.quantity, row.unit);
  if ('quantity' in routed) return { moved: false };
  const said = `sotuvchi: ${fmt(row.quantity)} ${row.unit.trim()}`;
  const base: RowUnitPatch = {
    quantity: null,
    unit: null,
    weightKg: row.weightKg,
    volumeM3: row.volumeM3,
    measureUnit: row.measureUnit,
    measureQty: row.measureQty,
  };
  if ('weightKg' in routed) {
    const conflict = row.weightKg !== null && row.weightKg !== routed.weightKg;
    if (row.weightKg === null) base.weightKg = routed.weightKg;
    return { moved: true, patch: base, to: 'kg', note: conflict ? `${said} (qatorda ${fmt(row.weightKg!)} kg)` : said, conflict };
  }
  if ('volumeM3' in routed) {
    const conflict = row.volumeM3 !== null && row.volumeM3 !== routed.volumeM3;
    if (row.volumeM3 === null) base.volumeM3 = routed.volumeM3;
    return { moved: true, patch: base, to: 'm3', note: conflict ? `${said} (qatorda ${fmt(row.volumeM3!)} m³)` : said, conflict };
  }
  if ('measureUnit' in routed) {
    const occupied = row.measureUnit !== null && row.measureQty !== null;
    const conflict =
      occupied && (row.measureUnit !== routed.measureUnit || row.measureQty !== routed.measureQty);
    if (!occupied) {
      base.measureUnit = routed.measureUnit;
      base.measureQty = routed.measureQty;
    }
    return {
      moved: true,
      patch: base,
      to: routed.measureUnit,
      note: conflict ? `${said} (qatorda ${fmt(row.measureQty!)} ${row.measureUnit})` : said,
      conflict,
    };
  }
  if ('cartons' in routed) return { moved: true, patch: base, to: 'cartons', note: said, conflict: false };
  return { moved: true, patch: base, to: 'unknown', note: said, conflict: false };
}

const fmt = (n: number) => String(Number(n.toFixed(4)));

/**
 * A row still stored the OLD way, before the doors learned units: the
 * seller's «120 m2» kept as 120 in the piece column, which the engine reads
 * as 120 pieces. ONE predicate for the save that heals it and for the screen
 * that says so BEFORE the press (judge UX7) — split, the sentence promises a
 * move the save does not make.
 *
 * Only a row nobody has priced or confirmed (judge MR-4): a price was typed
 * against the row as it stands, and a ✅ vouched for those very numbers.
 * - `move`: the save moves the number into the column its word names;
 * - `ask`: a carton count, a word nobody's list knows, or a pair the measure
 *   pass would not keep («40 m²» under a juft code, «120 m2» under a per-kg
 *   one) — the count is the VED's to answer, never the machine's guess.
 */
/** The four pair units — a type-checked copy, so this pure module needs no
 * runtime import from the engine. */
const MEASURE_UNIT_SET: ReadonlySet<string> = new Set<MeasureUnit>(['juft', 'litr', 'm2', 'sm3']);

export type PendingUnit =
  | { kind: 'move'; to: 'kg' | 'm3' | MeasureUnit; word: string; quantity: number; result: Extract<RowUnitResult, { moved: true }> }
  | { kind: 'ask'; word: string; quantity: number; result: Extract<RowUnitResult, { moved: true }> };

export function pendingUnitOf(
  row: RowUnitInput & { bazaUsd: number | null; bazaBasis: string | null },
  ctx: {
    confirmed: boolean;
    /** Whether the measure pass keeps a pair in this unit (`healPairKept`,
     * basis.ts) — passed in so this kernel stays free of the basis rules. */
    pairKept: (unit: MeasureUnit) => boolean;
  },
): PendingUnit | null {
  if (row.bazaUsd !== null || row.bazaBasis !== null || ctx.confirmed) return null;
  const result = normalizeRowUnit(row);
  if (!result.moved || row.quantity === null || !row.unit) return null;
  const word = row.unit.trim();
  // «40 m²» under a juft code, «120 m2» under a per-kg one: a pair the pass
  // would clear right after the move — the number would be gone.
  const contradicts = MEASURE_UNIT_SET.has(result.to) && !ctx.pairKept(result.to as MeasureUnit);
  if (result.to === 'cartons' || result.to === 'unknown' || contradicts) {
    return { kind: 'ask', word, quantity: row.quantity, result };
  }
  return { kind: 'move', to: result.to, word, quantity: row.quantity, result };
}


/**
 * The words a unit is printed in. One set of keys (`calc.units.*` in the four
 * bundles, and the client labels for the offer PDF) so «juft» is never printed
 * as a storage spelling and «sof og‘irlik (netto)» is spelt ONE way
 * (judge S5, UX16).
 */
export const UNIT_WORD_KEYS = ['dona', 'kg', 'kgNet', 'm3', 'm2', 'juft', 'litr', 'sm3', 'thousandDona'] as const;
export type UnitWordKey = (typeof UNIT_WORD_KEYS)[number];
export type UnitWords = Record<UnitWordKey, string>;

export function unitWordKey(unit: string): UnitWordKey | null {
  switch (unit) {
    case 'unit':
    case 'dona':
      return 'dona';
    case '1000_dona':
      return 'thousandDona';
    case 'kg':
    case 'm3':
    case 'm2':
    case 'juft':
    case 'litr':
    case 'sm3':
      return unit;
    default:
      return null;
  }
}

/** A stored unit spelling in the reader's words; an unknown spelling prints as
 * itself rather than vanishing. */
export function unitLabel(unit: string, words: UnitWords): string {
  const key = unitWordKey(unit);
  return key ? words[key] : unit;
}

/**
 * A row's piece count as text — «120 dona» — never the count glued to a word
 * that names ANOTHER column («300 kg» printed under a number that is pieces,
 * judge MR-6). The seller's word is kept only when it is itself a count word
 * («шт», «komplekt»).
 */
export function countText(quantity: number | null, unit: string | null, words: UnitWords): string {
  if (quantity === null) return '';
  const word = unit && unitOf(unit) === 'dona' ? unit.trim() : words.dona;
  return `${fmt(quantity)} ${word}`;
}
