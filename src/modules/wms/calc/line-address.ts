/**
 * How a typed answer names its row in the bot's table (docs/SAKKIZ-R3.md
 * §8.2.4, his 1.10 c and 1.11 c) — pure, so every address a seller types is a
 * test and never a reading of the dialogue.
 *
 * His two answers are the whole design: the questions are ONE table, and a
 * line is named by its number OR its name, in any order the seller writes it
 * («3: 50 dona», «3-qatorga 50 dona», «50 dona sumka», «строка 3: 50 шт»).
 * What the parser refuses it refuses with a reason, and the bot asks — a
 * figure landed on the wrong row is a duty computed on goods nobody stated.
 *
 * Imports R2's totals-shape helpers and the tier words from their zero-import
 * platform homes, never from calc-intake.ts, which imports staff-bot and so
 * the whole database (re-check p3-10, p3-16).
 */
import type { AmbiguousTotal } from './intake';
import { looksLikeMaterial, parseLineAnswer, parseManualFacts, type LineAnswer } from './intake-manual';
import type { NeedUnit } from './needs';
import { unitOf } from './units';
import { bareTotalsNumber, totalsAnswerShape, totalsFigureCount } from '../../platform/telegram/totals-shape';
import { TIER_WORDS, tierWords } from '../../platform/telegram/name-tiers';

/** What an answer — or an offer's button — is about: a line, a total, or the route. `line` is the row's `no`. */
export type TableTarget = { line: number } | { totals: 'weightKg' | 'volumeM3' } | { route: true };

/**
 * One goods line as the table shows it. `no` is the ONE number every surface
 * prints (`tableRowsOf`): a stored row's `seq` — gaps after a VED deletion stay
 * gaps, the same numbers the VED's screen and the 2.8 b ask print — a new
 * request's position, or `max(seq) + k` for a line an add collection adds.
 * `index` is where the line sits in `facts.goods`; `needs` the units it still
 * owes (empty = ✅).
 */
export interface TableRow {
  no: number;
  index: number;
  seq: number | null;
  name: string;
  needs: readonly NeedUnit[];
}

export interface TableRef {
  /** Every line, numbered as shown (`no`). */
  rows: readonly TableRow[];
  /** Every ⚠️ target. */
  open: readonly TableTarget[];
  /** What an UNADDRESSED answer may mean: the asked rows still ⚠️ when the collection was
   * opened from the 2.8 b block (product-fit-3), else `open`. */
  preferred: readonly TableTarget[];
  stage: 'review' | 'material';
}

export type TableRefusal =
  | 'no_line'
  | 'name_many'
  | 'name_none'
  | 'name_mismatch'
  | 'no_address'
  | 'address_unclear'
  | 'totals_unit';

export interface TableSegment {
  raw: string;
  at: TableTarget | null;
  refused: { reason: TableRefusal; detail: string; candidates?: number[] } | null;
  /** `parseLineAnswer(remainder)` for a line — kept on a refused name too, so the words can
   * show the seller his own figure back. */
  answer: LineAnswer | null;
  totals: { weightKg: number | null; volumeM3: number | null; ambiguous: AmbiguousTotal[] } | null;
  route: { fromCity: string | null; toCity: string | null } | null;
}

/**
 * The words a totals answer may start with — the table's own labels included
 * («umumiy brutto og‘irligi», «umumiy hajmi»), so every form the table teaches
 * is understood (product-fit-14): «og‘irligi 3500 kg» is a total, never a
 * goods name nobody has. The parser and the orphan guard read this one list.
 * Matched folded: apostrophes removed, Cyrillic kept for the Russian words
 * (and an Uzbek word typed in Cyrillic — «Жами», «умумий» — is read through
 * the same transliteration the names use).
 */
export const TOTALS_WORDS: readonly string[] = [
  'jami', 'jamisi', 'umumiy', 'obshiy', 'brutto', 'og‘irlik', 'og‘irligi', 'vazn', 'vazni', 'hajm',
  'hajmi', 'итого', 'всего', 'общий вес', 'брутто', 'вес', 'объём', 'объем', 'total', 'gross',
];

/** The totals words that name a field — «hajmi 12» is the cube, «vazni 3500» the kilos. */
const WEIGHT_WORDS = ['brutto', 'og‘irlik', 'og‘irligi', 'vazn', 'vazni', 'общий вес', 'брутто', 'вес', 'gross'];
const VOLUME_WORDS = ['hajm', 'hajmi', 'объём', 'объем'];

const APOSTROPHES = /[ʻʼ’'`‘ˈ]/gu;

/** Cyrillic → Latin, one table for every name the parser compares (§8.2.4). */
const CYRILLIC: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g',
  ҳ: 'h',
};

/** Lower, NFKC, apostrophes out, punctuation to space — the script left as written. */
function foldPlain(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** `foldPlain`, then Cyrillic → Latin: «Сумка» and «sumka» are one word. */
export function foldName(text: string): string {
  return foldPlain(text).replace(/\p{Script=Cyrillic}/gu, (ch) => CYRILLIC[ch] ?? ch);
}

const totalsKey = (word: string) => word.normalize('NFKC').toLowerCase().replace(APOSTROPHES, '');
const TOTALS_SET = new Set(TOTALS_WORDS.map(totalsKey));
const WEIGHT_SET = new Set(WEIGHT_WORDS.map(totalsKey));
const VOLUME_SET = new Set(VOLUME_WORDS.map(totalsKey));
const isTotalsKey = (key: string) => TOTALS_SET.has(key) || TOTALS_SET.has(foldName(key));
const fieldOfKey = (key: string): 'weightKg' | 'volumeM3' | null =>
  WEIGHT_SET.has(key) || WEIGHT_SET.has(foldName(key))
    ? 'weightKg'
    : VOLUME_SET.has(key) || VOLUME_SET.has(foldName(key))
      ? 'volumeM3'
      : null;

/**
 * A segment that opens with totals words — one or more, «umumiy brutto
 * og‘irligi», «общий вес» — each a whole word ending at a space, a colon or
 * the end (a lookahead and not `\b`: JS `\b` is ASCII-only, round 37's
 * «120кг»). «sof …» / «netto» / «нетто» is NOT one: «sof og‘irligi» is the
 * ROW's netto in `lineNeedText`'s own words. Null = no totals word first.
 */
function totalsLead(segment: string): { field: 'weightKg' | 'volumeM3' | null; rest: string } | null {
  const words = segment.trim().split(/\s+/u).filter(Boolean);
  const key = (w: string | undefined) => (w === undefined ? '' : totalsKey(w).replace(/[:：]$/u, ''));
  let i = 0;
  let field: 'weightKg' | 'volumeM3' | null = null;
  while (i < words.length) {
    const two = i + 1 < words.length && !/[:：]$/u.test(words[i]!) ? `${key(words[i])} ${key(words[i + 1])}` : null;
    if (two && isTotalsKey(two)) {
      field = fieldOfKey(two) ?? field;
      i += 2;
      continue;
    }
    const one = key(words[i]);
    if (!isTotalsKey(one)) break;
    field = fieldOfKey(one) ?? field;
    i += 1;
  }
  return i === 0 ? null : { field, rest: words.slice(i).join(' ') };
}

/** The one ⚠️ totals target, when exactly one is open — what a bare figure means there. */
function onlyOpenTotal(open: readonly TableTarget[]): 'weightKg' | 'volumeM3' | null {
  const totals = open.flatMap((t) => ('totals' in t ? [t.totals] : []));
  return totals.length === 1 ? totals[0]! : null;
}

/**
 * A totals remainder, read as R2's answer path reads it: `parseManualFacts`
 * with NO section — a netto-labelled kilo answers no total (PF-1:
 * `mergeTotalsAnswer` takes an answered weight as BRUTTO), so it is refused
 * and never stored (re-check p3-20). A bare remainder takes the unit its words
 * named, else the single open total's; two bare figures are never one weight
 * — R2's P3-R7, «12 3500» dropped the 12 in silence (re-check p3-6).
 */
function readTotals(
  rest: string,
  field: 'weightKg' | 'volumeM3' | null,
  open: readonly TableTarget[],
): NonNullable<TableSegment['totals']> | 'totals_unit' {
  const read = parseManualFacts(rest);
  if (read.weightKg != null || read.volumeM3 != null || read.ambiguous.length > 0) {
    return { weightKg: read.weightKg ?? null, volumeM3: read.volumeM3 ?? null, ambiguous: read.ambiguous };
  }
  if (!bareTotalsNumber(rest)) return 'totals_unit';
  if (totalsFigureCount(rest) > 1) return 'totals_unit';
  const unit = field ?? onlyOpenTotal(open);
  if (unit === null) return 'totals_unit';
  const worded = parseManualFacts(`${rest.trim()} ${unit === 'weightKg' ? 'kg' : 'kub'}`);
  return { weightKg: worded.weightKg ?? null, volumeM3: worded.volumeM3 ?? null, ambiguous: worded.ambiguous };
}

/**
 * The number address, stripped BEFORE `parseLineAnswer` — handed the whole
 * segment, «3: 6403990000 40 juft» read q = 3, and «3 - 50 dona» was refused by
 * the minus guard (both probe-proven). «3.» is an address only with a SPACE
 * after it: «3.5 kg» is a figure. Any suffix after «qator» («-qatordagi»,
 * product-fit-13), ordinals («3-chi», «3chi», «3-nchi»), and the Russian
 * «3 строка».
 */
const REVIEW_ADDRESS =
  /^\s*(?:#|№)?\s*(\d{1,4})(?:-?(?:chi|nchi))?(?:\s*[:)]|\.(?=\s)|\s+[-–—](?=\s)|\s*-?\s*(?:qator|строк)\p{L}*(?=[\s:,.]|$)|(?<=chi)(?=\s))\s*/iu;
/** «#3 50 dona», «№3 …» — the sign is the address's own mark, a space is enough after it. */
const SIGN_ADDRESS = /^\s*[#№]\s*(\d{1,4})(?=\s)\s*/u;
/** «строка 3: …», «стр. 3 …», «qator 3 …» — the word first. */
const WORD_FIRST_ADDRESS = /^\s*(?:qator|строка|стр\.?)\s*(\d{1,4})(?=[\s:,.]|$)[:\s]*/iu;
/**
 * In the material stage only «N:» and «N-qator…» (ordinal or not) address a
 * row (regression-3): a hand-typed numbered list («1. Kurtka 300 dona»,
 * c1524-c1526) is goods, which is where «➕ Yana ma’lumot» left the seller.
 */
const MATERIAL_ADDRESS = /^\s*(\d{1,4})(?:-?(?:chi|nchi))?(?:\s*:|\s*-?\s*(?:qator|строк)\p{L}*(?=[\s:,.]|$))\s*/iu;

function addressOf(segment: string, stage: TableRef['stage']): { n: number; rest: string } | null {
  const forms = stage === 'review' ? [REVIEW_ADDRESS, SIGN_ADDRESS, WORD_FIRST_ADDRESS] : [MATERIAL_ADDRESS, WORD_FIRST_ADDRESS];
  for (const form of forms) {
    const hit = form.exec(segment);
    if (hit) return { n: Number(hit[1]), rest: segment.slice(hit[0].length).trim() };
  }
  return null;
}

/**
 * Words that say WHICH figure, never which goods — a row's own field words in
 * `lineNeedText`'s spelling («sof og‘irligi», «juft soni», «maydoni»), the
 * code's label, the address words and the fillers. A totals word is never a
 * name either (`TOTALS_WORDS`, asked apart). Folded.
 */
const FIELD_WORDS = new Set([
  'soni', 'son', 'sof', 'maydoni', 'miqdori', 'kod', 'kodi', 'tnved', 'netto', 'nett', 'qator', 'stroka', 'str',
  'uchun', 'dlya', 'for', 'yoki', 'ham',
]);

/**
 * «dvigatel hajmi» — the sm³ need's own words (`needWhatUz('sm3')`), read as a
 * PHRASE: «dvigatel» alone is a goods noun («Dvigatel 1.5L»), and as a lone
 * field word it hid that row's name (review spec-11).
 */
const ENGINE_FIELD = /(?:dvigatel|двигател)\p{L}*\s+(?:hajm|ҳажм|хажм|объ[её]м)\p{L}*/giu;

/**
 * A figure grouped by thousands — «1 200», «3 500», «12 000» — is ONE figure,
 * the house rule `TOTALS_NUMBER` and `parseLineAnswer` both read (R2's P3-R7).
 * Read as two numbers, «3 500 kg» was asked «3-qatorgami yoki 3 tami?» and
 * «Sumka 1 200 dona» took «1» for a model number (review spec-3, adv-1/-2).
 */
const GROUPED = /(?<![\d.,])(\d{1,3})((?:\s\d{3})+)(?![\d.,])/gu;
const GROUPED_FIRST = /^\s*\d{1,3}(?:\s\d{3})+(?![\d.,])/u;

/**
 * The text a segment's figures are read from: a spaced dash between the goods
 * words and the first figure is a separator («Shapka - 30 dona», the easy key
 * on a phone), never a minus — `parseLineAnswer`'s minus guard refused it
 * (review spec-5, adv-15). The number address strips its own dash already.
 */
const figureText = (text: string) => text.replace(/(\p{L}[\p{L}\p{N}]*)\s+[-–—]\s+(?=\d)/gu, '$1 ');

/** What a segment says about WHICH goods, once its figures, units, codes and field words are set aside. */
interface NameParts {
  /** Goods words, folded, three letters or more. */
  words: string[];
  /** Han runs — met as a substring. */
  han: string[];
  /** Digit runs that belong to the NAME («iPhone 15», «S24»), not to a figure. */
  digits: string[];
  /** A model's tier words after its number (`tierWords`). */
  tiers: Set<string>;
  /** A carton word: a unit (units.ts), never a name — and never a row's figure. */
  carton: boolean;
  /** The goods words as typed, for the refusal's words. */
  typed: string;
}

const digitKey = (run: string) => run.replace(/^0+(?=\d)/u, '');

function nameParts(raw: string): NameParts {
  const text = raw
    .replace(ENGINE_FIELD, ' ')
    .replace(GROUPED, (_m, head: string, groups: string) => head + groups.replace(/\s/gu, ''))
    // A figure glued to a name by a dash («Sumka-50 dona») is the figure, as
    // `parseLineAnswer` reads it — never a model number of «Sumka».
    .replace(/(\p{L})[-–—](\d[\d.,]*)(?=\s*([\p{L}²³]+))/gu, (m, letter: string, digits: string, unit: string) =>
      unitOf(unit) !== null ? `${letter} ${digits}` : m,
    );
  const tokens = text.split(/[\s,;:()«»"]+/u).filter(Boolean);
  const words: string[] = [];
  const han: string[] = [];
  const digits: string[] = [];
  const typed: string[] = [];
  let carton = false;
  const tiers = tierWords(foldPlain(text));
  const isUnit = (t: string) => unitOf(t) !== null || unitOf(foldName(t)) !== null;
  tokens.forEach((token, i) => {
    if (unitOf(token) === 'karobka' || unitOf(foldName(token)) === 'karobka') {
      carton = true;
      return;
    }
    if (isUnit(token)) return;
    // A number: a figure when a unit follows it (or is glued to it — «40juft»),
    // a code when it is one, the answer when it ends the segment; part of the
    // NAME when a word that is no unit follows it («iPhone 15 Pro», «Stul 2 xil»)
    // or another number does («iPhone 15 40 dona»).
    if (/^\d[\d.,]*$/u.test(token)) {
      const next = tokens[i + 1];
      const bare = token.replace(/[.,]/gu, '');
      if (bare.length >= 9) return;
      if (next === undefined || isUnit(next)) return;
      if (/^\d/u.test(next) || /\p{L}/u.test(next)) digits.push(digitKey(bare));
      return;
    }
    const glued = /^(\d[\d.,]*)(\p{L}+)$/u.exec(token);
    if (glued && isUnit(glued[2]!)) return;
    for (const word of foldName(token).split(' ').filter(Boolean)) {
      for (const run of word.match(/\d+/gu) ?? []) digits.push(digitKey(run));
      const letters = word.replace(/[^\p{L}]/gu, '');
      if (letters === '') continue;
      const hanRuns = letters.match(/\p{Script=Han}+/gu);
      if (hanRuns) {
        han.push(...hanRuns);
        typed.push(token);
        continue;
      }
      if (FIELD_WORDS.has(letters) || isTotalsKey(totalsKey(token)) || isTotalsKey(letters)) continue;
      const tier = TIER_WORDS[letters];
      if (tier !== undefined && tiers.has(tier)) continue;
      if (letters.length < 3) continue;
      words.push(letters);
      typed.push(token);
    }
  });
  return { words, han, digits, tiers, carton, typed: typed.join(' ') };
}

/** Two words meet when they share a long enough start: «krossovka»/«krossovki», «sumka»/«sumkalar». */
function meets(w: string, v: string): boolean {
  let p = 0;
  while (p < w.length && p < v.length && w[p] === v[p]) p += 1;
  return p >= Math.max(3, Math.min(w.length, v.length) - 2);
}

interface RowName {
  folded: string;
  words: string[];
  digits: Set<string>;
  tiers: Set<string>;
}

function rowName(name: string): RowName {
  const folded = foldName(name);
  return {
    folded,
    words: folded.split(' ').map((w) => w.replace(/[^\p{L}]/gu, '')).filter(Boolean),
    digits: new Set((folded.match(/\d+/gu) ?? []).map(digitKey)),
    tiers: tierWords(foldPlain(name)),
  };
}

/** Do the typed goods words name this row — every word met, every Han run inside it? */
function namesRow(parts: NameParts, row: RowName): boolean {
  return parts.words.every((w) => row.words.some((v) => meets(w, v))) && parts.han.every((h) => row.folded.includes(h));
}

/**
 * `otherName`'s rule (#1468), one-way: a digit run or a model tier the typed
 * name holds and the row's name does not drops the row — «iPhone 14» is not
 * «iPhone 15», «iPhone 15» is not «iPhone 15 Pro» (re-check p3-16).
 */
function holdsModel(parts: NameParts, row: RowName): boolean {
  return parts.digits.every((d) => row.digits.has(d)) && [...parts.tiers].every((t) => row.tiers.has(t));
}

const hasName = (parts: NameParts) => parts.words.length > 0 || parts.han.length > 0;

/** The units an answer states, in the needs' vocabulary — empty for a bare figure. */
function answerUnits(answer: LineAnswer): NeedUnit[] {
  if (answer.kind === 'figures') {
    const f = answer.figures;
    return [
      ...(f.quantity !== null ? (['dona'] as const) : []),
      ...(f.weightKg !== null ? (['kg'] as const) : []),
      ...(f.volumeM3 !== null ? (['m3'] as const) : []),
      ...(f.measureUnit !== null && f.measureQty !== null ? [f.measureUnit] : []),
    ];
  }
  if (answer.kind === 'ambiguous' && answer.unit !== null && answer.unit !== 'karobka') return [answer.unit];
  return [];
}

/** A segment the seller labelled NETTO — the row's own weight, never the brutto total. */
const NETTO_FIRST = /^\s*(?:sof|netto|нетто|net|n\.?\s?w\.?)(?![\p{L}])/iu;

const isLine = (t: TableTarget): t is { line: number } => 'line' in t;

/**
 * Where an UNADDRESSED answer goes (product-fit-1, -3): the single `preferred`
 * target; among several, the single one whose needs hold the answer's unit
 * («40 juft» → the one juft row, a kg answer → the one kg row or the weight
 * total); a bare figure only with ONE target. A single preferred target that
 * cannot hold the unit gives way to the one open target that can — «3500 kg»
 * typed under the 2.8 b ask for a juft count is the brutto, never the shoes'
 * weight. `both` = every fitting target is a total («12 kub 3500 kg»).
 */
function targetFor(answer: LineAnswer, table: TableRef, netto: boolean): TableTarget | 'both' | null {
  const units = answerUnits(answer);
  const rowOf = (t: { line: number }) => table.rows.find((r) => r.no === t.line);
  const fits = (t: TableTarget): boolean => {
    if (isLine(t)) {
      const needs = rowOf(t)?.needs ?? [];
      return needs.some((u) => units.includes(u) || (u === '1000_dona' && units.includes('dona')));
    }
    // A total takes only kilos and cubes: «300 dona 150 kg» is a row's
    // figures, never a brutto (review adv-14).
    if ('totals' in t) return !netto && units.every((u) => u === 'kg' || u === 'm3') && units.includes(t.totals === 'weightKg' ? 'kg' : 'm3');
    return false;
  };
  const pool = table.preferred.filter((t) => !('route' in t) && (!netto || isLine(t)));
  if (units.length === 0) {
    if (pool.length === 1) return pool[0]!;
    // Only the totals are open: the figure is one of them, and which one is
    // asked in the totals' own words («jami 3500 kg» yoki «jami 12 kub»).
    return pool.length > 1 && pool.every((t) => 'totals' in t) ? 'both' : null;
  }
  if (pool.length === 1) {
    const only = pool[0]!;
    if (fits(only)) return only;
    const fitting = table.open.filter(fits);
    if (fitting.length === 1) return fitting[0]!;
    return isLine(only) ? only : null;
  }
  const fitting = pool.filter(fits);
  if (fitting.length === 1) return fitting[0]!;
  if (fitting.length > 1 && fitting.every((t) => 'totals' in t)) return 'both';
  return null;
}

/** The segment's own words for a reading the parser could not place. */
const refused = (raw: string, reason: TableRefusal, detail: string, extra: Partial<TableSegment> = {}): TableSegment => ({
  raw,
  at: null,
  refused: { reason, detail },
  answer: null,
  totals: null,
  route: null,
  ...extra,
});

/** Which total a totals reading answers first — the weight when it states (or doubts) one. */
function totalsTarget(totals: NonNullable<TableSegment['totals']>): TableTarget {
  const weight = totals.weightKg != null || totals.ambiguous.some((a) => a.field === 'weightKg');
  return { totals: weight ? 'weightKg' : 'volumeM3' };
}

/** «3 50 dona» — no separator: the row's number or a count? Asked, never guessed. */
const UNCLEAR = /^\s*(\d{1,4})\s+(\d[\d.,]*)\s*([\p{L}²³]+)/u;

interface ReadSegment extends TableSegment {
  /** Addressed by a number, a sign or a totals word — what the material stage takes. */
  explicit: boolean;
  /** A goods-word segment that named no row (rule 3's evidence of a typed goods list). */
  namedNone: boolean;
}

function readSegment(raw: string, table: TableRef): ReadSegment {
  const plain = { explicit: false, namedNone: false };
  const address = addressOf(raw, table.stage);
  if (address) {
    const row = table.rows.find((r) => r.no === address.n);
    if (!row) return { ...refused(raw, 'no_line', String(address.n)), explicit: true, namedNone: false };
    const answer = parseLineAnswer(figureText(address.rest));
    const parts = nameParts(address.rest);
    // The words after the number must not name ANOTHER row (regression-3):
    // «1. Kurtka 300 dona» on row 1 Krossovka is a list of other goods, asked.
    if (hasName(parts)) {
      const name = rowName(row.name);
      if (!namesRow(parts, name) || !holdsModel(parts, name)) {
        return {
          ...refused(raw, 'name_mismatch', parts.typed || raw, { at: { line: row.no }, answer }),
          refused: { reason: 'name_mismatch', detail: parts.typed || raw, candidates: [row.no] },
          explicit: true,
          namedNone: false,
        };
      }
    }
    return { raw, at: { line: row.no }, refused: null, answer, totals: null, route: null, explicit: true, namedNone: false };
  }

  const lead = totalsLead(raw);
  if (lead) {
    const totals = readTotals(lead.rest, lead.field, table.open);
    if (totals === 'totals_unit') return { ...refused(raw, 'totals_unit', raw), explicit: true, namedNone: false };
    return { raw, at: totalsTarget(totals), refused: null, answer: null, totals, route: null, explicit: true, namedNone: false };
  }

  // The material stage takes only an explicit address; everything else is goods.
  if (table.stage === 'material') return { ...refused(raw, 'no_address', raw), ...plain };

  if (!/\d/u.test(raw)) {
    const facts = parseManualFacts(raw);
    if (facts.fromCity || facts.toCity) {
      return { raw, at: { route: true }, refused: null, answer: null, totals: null, route: { fromCity: facts.fromCity ?? null, toCity: facts.toCity ?? null }, ...plain };
    }
  }

  const unclear = GROUPED_FIRST.test(raw) ? null : UNCLEAR.exec(raw);
  if (unclear && Number(unclear[1]) <= table.rows.length && unitOf(unclear[3]) !== null) {
    return { ...refused(raw, 'address_unclear', unclear[1]!), ...plain };
  }

  const answer = parseLineAnswer(figureText(raw));
  const parts = nameParts(raw);
  if (parts.carton) return { ...refused(raw, 'no_address', raw), ...plain };
  // No goods word left over: an ANSWER, to the target its unit fits.
  if (!hasName(parts)) {
    if (answer.kind === 'refused') return { ...refused(raw, 'no_address', raw), ...plain };
    const target = targetFor(answer, table, NETTO_FIRST.test(raw));
    if (target === null) return { ...refused(raw, 'no_address', raw, { answer }), ...plain };
    if (target === 'both' || 'totals' in target) {
      const totals = readTotals(raw, target === 'both' ? null : target.totals, table.open);
      if (totals === 'totals_unit') return { ...refused(raw, 'totals_unit', raw), ...plain };
      return { raw, at: target === 'both' ? totalsTarget(totals) : target, refused: null, answer: null, totals, route: null, ...plain };
    }
    return { raw, at: target, refused: null, answer, totals: null, route: null, ...plain };
  }

  // Goods words: the NAME address, read before or after the figure («50 dona
  // sumka», «40 juft krossovka» — ordinary Uzbek word order, product-fit-13).
  const met = table.rows.filter((r) => namesRow(parts, rowName(r.name)));
  if (met.length === 0) return { ...refused(raw, 'name_none', parts.typed || raw, { answer }), explicit: false, namedNone: true };
  const kept = met.filter((r) => holdsModel(parts, rowName(r.name)));
  if (kept.length === 0) {
    return {
      ...refused(raw, 'name_mismatch', parts.typed || raw, { answer, at: { line: met[0]!.no } }),
      refused: { reason: 'name_mismatch', detail: parts.typed || raw, candidates: [met[0]!.no] },
      ...plain,
    };
  }
  if (kept.length > 1) {
    return {
      ...refused(raw, 'name_many', parts.typed || raw, { answer }),
      refused: { reason: 'name_many', detail: parts.typed || raw, candidates: kept.map((r) => r.no) },
      ...plain,
    };
  }
  return { raw, at: { line: kept[0]!.no }, refused: null, answer, totals: null, route: null, ...plain };
}

/**
 * The text's segments: lines and «;» always; a comma only when EVERY part of
 * it starts with an address — «Kurtka (qora, XL) 50 dona» stays one, while
 * «sumka 50 dona, kurtka 20 kg» is two by name. A comma between digits is a
 * number («1,200 kg»).
 */
function segmentsOf(text: string, startsAddressed: (part: string) => boolean): string[] {
  return text
    .split(/\r?\n|;/u)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const commas = part
        .split(/,(?!\d)|(?<!\d),/u)
        .map((s) => s.trim())
        .filter(Boolean);
      return commas.length > 1 && commas.every(startsAddressed) ? commas : [part];
    });
}

/**
 * A typed answer, split into segments and each addressed (§8.2.4). `material`
 * = the text is GOODS, not an answer — in the table stage only a typed list of
 * several lines whose names meet no row (rule 3); in the material stage
 * anything not explicitly addressed. Nothing here writes: the dialogue applies
 * the segments and words the refusals.
 */
export function parseTableAnswer(text: string, table: TableRef): { segments: TableSegment[]; material: boolean } {
  const startsAddressed = (part: string): boolean =>
    addressOf(part, table.stage) !== null ||
    totalsLead(part) !== null ||
    (table.stage === 'review' && hasName(nameParts(part)) && table.rows.some((r) => namesRow(nameParts(part), rowName(r.name))));
  const read = segmentsOf(text, startsAddressed).map((raw) => readSegment(raw, table));
  const strip = (s: ReadSegment): TableSegment => ({
    raw: s.raw,
    at: s.at,
    refused: s.refused,
    answer: s.answer,
    totals: s.totals,
    route: s.route,
  });
  if (table.stage === 'material') {
    // Answers only when every segment is EXPLICITLY addressed and none names
    // other goods: «1: Kurtka 300 dona» typed after «➕ Yana ma’lumot» is the
    // seller's list, never a correction of row 1.
    const answers = read.length > 0 && read.every((s) => s.explicit && s.refused?.reason !== 'name_mismatch');
    return answers ? { segments: read.map(strip), material: false } : { segments: [], material: true };
  }
  // Rule 3: several segments, none addressed, none naming a row — a typed goods
  // list, the ONE way a typed text becomes material in the table stage.
  if (read.length > 1 && read.every((s) => s.namedNone) && looksLikeMaterial(text)) {
    return { segments: [], material: true };
  }
  return { segments: read.map(strip), material: false };
}

/**
 * The remainder after an address is figures and units, a code, and at most a
 * two-word row name — and a bare number is never followed by words («1) 2026
 * oktyabr hisoboti» is a heading, not an answer).
 */
function figuresOnly(rest: string): boolean {
  const tokens = rest.replace(/[,·]/gu, ' ').trim().split(/\s+/u).filter(Boolean);
  let figures = 0;
  let names = 0;
  let lastBare = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (/^\d[\d.]*$/u.test(t) && t.replace(/\./gu, '').length === 10) continue;
    if (/^\d[\d.]*$/u.test(t)) {
      const next = tokens[i + 1];
      if (next !== undefined && unitOf(next) !== null) {
        figures += 1;
        lastBare = false;
        i += 1;
        continue;
      }
      figures += 1;
      lastBare = true;
      continue;
    }
    const glued = /^\d[\d.]*(\p{L}+)$/u.exec(t);
    if (glued && unitOf(glued[1]) !== null) {
      figures += 1;
      lastBare = false;
      continue;
    }
    if (unitOf(t) !== null || /^(?:kod|код)$/iu.test(t)) continue;
    if (/^\p{L}[\p{L}'’‘ʻ`-]*$/u.test(t)) {
      if (lastBare) return false;
      names += 1;
      continue;
    }
    return false;
  }
  return figures > 0 && names <= 2;
}

const shapeSegments = (text: string) =>
  segmentsOf(text, (part) => addressOf(part, 'review') !== null);

/** One segment is a number address followed only by figures (`figuresOnly`). */
function lineAnswerSegment(segment: string): boolean {
  const address = addressOf(segment, 'review');
  return address !== null && figuresOnly(address.rest);
}

/**
 * True only when EVERY segment is a number address followed by figures and
 * units, with at most a two-word row name (regression-21): «3: 50 dona\n5: 20
 * kg» is; «1) 2026 oktyabr hisoboti» and «1. Kurtka 300 dona, 2. Shim 200 dona
 * — boj qancha?» are not, and a numbered QUESTION still reaches the assistant.
 */
export function looksLikeLineAnswer(text: string): boolean {
  const segments = shapeSegments(text);
  return segments.length > 0 && segments.every(lineAnswerSegment);
}

/** A totals word followed only by figures and units — «jami 3500 kg», «og‘irligi 3500 kg», «брутто 3500 кг». */
function totalsWordAnswer(segment: string): boolean {
  const lead = totalsLead(segment);
  return lead !== null && lead.rest !== '' && totalsAnswerShape(lead.rest) !== null;
}

/**
 * The guard the pause line and the orphan sentence ask (re-check p3-2,
 * p3-10): per segment, a WORDED figure (`totalsAnswerShape === 'worded'`, R2's
 * REG-3 shape), a `TOTALS_WORDS` word followed only by figures and units, or a
 * line answer (`looksLikeLineAnswer`'s segment). A BARE figure («777») is not
 * table-shaped: it is answered apart (§8.2 rule 11).
 */
export function looksLikeTableAnswer(text: string): boolean {
  const segments = shapeSegments(text);
  return (
    segments.length > 0 &&
    segments.every((s) => totalsAnswerShape(s) === 'worded' || totalsWordAnswer(s) || lineAnswerSegment(s))
  );
}
