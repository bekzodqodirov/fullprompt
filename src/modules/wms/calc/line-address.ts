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
import { exampleFigure, type AmbiguousTotal } from './intake';
import {
  looksLikeMaterial,
  MATERIAL_ROW_ADDRESS,
  parseLineAnswer,
  parseManualFacts,
  readTypedTotals,
  type LineAnswer,
} from './intake-manual';
import type { NeedUnit } from './needs';
import {
  amountsIn,
  blankSpan,
  codeIn,
  joinUnitPhrases,
  labelPattern,
  nearUnit,
  NET_LABELS,
  scaledKg,
  scaledPattern,
  TOTALS_LEAD_LABELS,
  UNIT_FREE_LABELS,
  unitOf,
  unitPattern,
  unitWords,
  VOLUME_LABELS,
  WEIGHT_LABELS,
} from './units';
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

/**
 * A figure of a totals answer that no total could take (docs/AI-SORAYDI.md
 * §3.1 T2) — named in the refusal, never dropped: «jami 507 kg 300 dona»
 * wrote the kilos and put a 👍 over a count nobody kept.
 *  - `row`: a count or a pair («300 dona», «40 juft») — a row's figure;
 *  - `netto`: a kilo labelled netto — the total is asked as BRUTTO (PF-1);
 *  - `weight` / `volume`: a kilo / a cube the reading did not take — two
 *    different ones were written;
 *  - `bare`: a number with no unit;
 *  - `unit`: a number and a word that is no unit («5.9 kubik») — asked as a
 *    unit (T3), with the kilo or cube the word most likely means (`near`).
 */
export interface TotalsLeft {
  why: 'row' | 'netto' | 'weight' | 'volume' | 'bare' | 'unit';
  /** As the seller wrote it — «300 dona», «netto 480 kg», «5.9 kubik», «7.19». */
  text: string;
  /** The figure without its label — «480 kg» of «netto 480 kg» — what an example is built from. */
  figure: string;
  /** The number alone, as written. */
  number: string;
  word?: string;
  near?: UnitAsk['near'];
}

/**
 * A figure whose word is NO unit and names no row — «5.9 kubik», «507
 * kilogr», «300 banka» (docs/AI-SORAYDI.md §3.1 T3, dg3-04): asked as a unit,
 * never called goods the table has no row for. `near` is the kilo or the cube
 * the word most likely means (units.ts `nearUnit`); the refusal's REASON stays
 * what it was, so every door files the segment as it always did.
 */
export interface UnitAsk {
  word: string;
  /** The number as written — what the example is built from. */
  number: string;
  /**
   * What the word most likely means: a kilo or a cube with an ending on it
   * (`nearUnit`), or — for a lone «t» / «g» where nothing says it is a weight,
   * and for one glued to its digits («2T») — the tonne or the gram it would
   * be (T14, review JN-9): asked, never read.
   */
  near: 'kg' | 'm3' | 'tonna' | 'gr' | null;
}

/** `UnitAsk.near` of a word that is no unit. */
function nearOf(word: string): UnitAsk['near'] {
  const scale = scaledKg(word);
  if (scale?.lone) return scale.factor > 1 ? 'tonna' : 'gr';
  return nearUnit(word);
}

export interface TableSegment {
  raw: string;
  at: TableTarget | null;
  /**
   * `left` (a `totals_unit` refusal): the figures it is about — the words name
   * each (T2). `unit`: the refusal is about a word that is no unit (T3).
   */
  refused: { reason: TableRefusal; detail: string; candidates?: number[]; left?: TotalsLeft[]; unit?: UnitAsk } | null;
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
 *
 * The words that name a FIELD — «hajmi 12» is the cube, «vazni 3500» the
 * kilos — are the vocabulary's (units.ts `TOTALS_LEAD_LABELS`, docs/
 * AI-SORAYDI.md §2.4): this file kept a list of its own, the third one, and
 * the three had drifted apart. Only the words that say «all of it» live here.
 */
export const TOTALS_WORDS: readonly string[] = [
  'jami', 'jamisi', 'umumiy', 'obshiy', 'итого', 'всего', 'total',
  ...TOTALS_LEAD_LABELS.weightKg,
  ...TOTALS_LEAD_LABELS.volumeM3,
];

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
const WEIGHT_SET = new Set(TOTALS_LEAD_LABELS.weightKg.map(totalsKey));
const VOLUME_SET = new Set(TOTALS_LEAD_LABELS.volumeM3.map(totalsKey));

/**
 * The words a worded totals answer is written in — every kilo and cube word
 * of the vocabulary, the tonne and the gram in the spellings that can be
 * nothing else («jami 2 tonna», T14), and the labels a totals answer may
 * carry («3500 kg brutto») — for the platform's shape test (`totalsAnswerShape`, which imports
 * nothing and so is handed it). Matched over a lower-cased text; a word,
 * never a part of one («kubik»).
 */
export const TOTALS_UNIT_WORDS = new RegExp(
  `(?<![\\p{L}])(?:${unitPattern('kg')}|${unitPattern('m3')}|${scaledPattern('words')}|${labelPattern([
    ...TOTALS_LEAD_LABELS.weightKg,
    ...TOTALS_LEAD_LABELS.volumeM3,
  ])})(?![\\p{L}\\d])`,
  'giu',
);
/** `totalsAnswerShape` in the vocabulary's words — the one way this file asks it. */
const totalsShape = (text: string) => totalsAnswerShape(text, TOTALS_UNIT_WORDS);
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
): TotalsReading {
  // The answer to the bot's own question about the totals: a lone «t» / «g»
  // after a number is its unit there («jami 2 t» — T14, review JN-9).
  const { facts: read, taken } = readTypedTotals(rest, undefined, { totalsAnswer: true });
  const left = totalsLeft(rest, taken);
  if (read.weightKg != null || read.volumeM3 != null || read.ambiguous.length > 0) {
    const totals = { weightKg: read.weightKg ?? null, volumeM3: read.volumeM3 ?? null, ambiguous: read.ambiguous };
    // «og‘irligi 3500, 12 kub»: the word named the field of the one bare
    // figure the answer holds — it is that field's, when nothing else is.
    const bare = left.filter((l) => l.why === 'bare');
    const doubted = (f: 'weightKg' | 'volumeM3') => totals.ambiguous.some((a) => a.field === f);
    if (field !== null && bare.length === 1 && totals[field] === null && !doubted(field)) {
      const worded = wordedTotal(bare[0]!.number, field);
      if (worded[field] != null || worded.ambiguous.length > 0) {
        return {
          totals: { ...totals, [field]: worded[field] ?? null, ambiguous: [...totals.ambiguous, ...worded.ambiguous] },
          left: left.filter((l) => l !== bare[0]),
        };
      }
    }
    return { totals, left };
  }
  // Nothing a total could take. A bare figure keeps its own sentence (the
  // unit is asked); anything else the answer holds is named.
  const named = left.filter((l) => l.why !== 'bare');
  if (!bareTotalsNumber(rest)) return { totals: null, left: named };
  if (totalsFigureCount(rest) > 1) return { totals: null, left: [] };
  const unit = field ?? onlyOpenTotal(open);
  if (unit === null) return { totals: null, left: [] };
  const worded = wordedTotal(rest.trim(), unit);
  return { totals: { weightKg: worded.weightKg ?? null, volumeM3: worded.volumeM3 ?? null, ambiguous: worded.ambiguous }, left: [] };
}

/** A bare figure read as `field`'s — through the same reader, in the field's first unit word. */
const wordedTotal = (number: string, field: 'weightKg' | 'volumeM3') =>
  parseManualFacts(`${number} ${unitWords(field === 'weightKg' ? 'kg' : 'm3')[0]}`);

/** What a totals remainder states: the totals it gives (null — none), and every figure of it no total took. */
interface TotalsReading {
  totals: NonNullable<TableSegment['totals']> | null;
  left: TotalsLeft[];
}

/**
 * A word that LABELS a figure and is no unit of it — «3500 brutto», «12
 * hajmi», «507 G.W.»: the number before it is bare, never «507 of brutto».
 */
const LABEL_WORD = new RegExp(
  `^(?:${labelPattern([...WEIGHT_LABELS, ...NET_LABELS, ...VOLUME_LABELS])}|sof|jami|jamisi|umumiy|obshiy|итого|всего|total)$`,
  'iu',
);
/** A netto label closing the words before a figure («netto 480 kg», «N.W.: 480 kg»), or opening the words after it. */
const NETTO_LABEL_BEFORE = new RegExp(`(?<![\\p{L}])((?:${labelPattern(NET_LABELS)}|sof))[\\s.:：=–—-]*$`, 'iu');
const NETTO_LABEL_AFTER = new RegExp(`^\\s*[(\\[]?\\s*((?:${labelPattern(NET_LABELS)}))(?![\\p{L}])(?![\\s.:：=–—-]*\\d)`, 'iu');

/**
 * The figures of a text whose word is no unit and no label — «5.9 kubik»,
 * «300 banka», «15 Pro» — as the kernel's own grammar finds them (T3).
 */
function unknownUnits(text: string): UnitAsk[] {
  return amountsIn(text).flatMap((a) =>
    // A tonne or a gram spelled out is READ; a lone «t» / «g» is a word nobody placed.
    a.word !== null && unitOf(a.word) === null && scaledKg(a.word)?.lone !== false && !LABEL_WORD.test(a.word)
      ? [{ word: a.word, number: a.number, near: nearOf(a.word) }]
      : [],
  );
}

/**
 * Every figure of a totals answer that stands OUTSIDE what the totals reading
 * took (`taken`, intake-manual.ts `readTypedTotals`) — T2. The figures are
 * found by the kernel's own grammar (`amountsIn`), a TNVED code set aside.
 * NOT left: a carton count — «TOTAL: 15 CTNS, G.W.: 507 KGS, MEAS: 5.92 CBM»
 * is the forwarder's line as he writes it, no total asks how the cargo is
 * packed, and a carton is no figure of a row either.
 */
function totalsLeft(rest: string, taken: readonly [number, number][]): TotalsLeft[] {
  let remainder = rest;
  for (const [start, end] of taken) remainder = blankSpan(remainder, start, end);
  const code = codeIn(remainder);
  if (code) remainder = blankSpan(remainder, code.start, code.end);
  const out: TotalsLeft[] = [];
  for (const amount of amountsIn(remainder)) {
    const unit = amount.word ? unitOf(amount.word) : null;
    if (unit === 'karobka') continue;
    const { number } = amount;
    if (amount.word === null || (unit === null && LABEL_WORD.test(amount.word))) {
      out.push({ why: 'bare', text: number, figure: number, number });
      continue;
    }
    const text = remainder.slice(amount.start, amount.end).replace(/\s+/gu, ' ').trim();
    // A tonne or a gram is a KILO figure here — the answer's reader reads the
    // spelled word and the lone letter alike (`totalsAnswer`). Only a lone
    // letter GLUED to its digits («2T») is read by nobody, and is asked.
    const scale = unit === null ? scaledKg(amount.word) : null;
    const kilos = unit === 'kg' || (scale !== null && !(scale.lone && !/\s/u.test(text)));
    if (unit === null && !kilos) {
      out.push({ why: 'unit', text, figure: text, number, word: amount.word, near: nearOf(amount.word) });
    } else if (kilos) {
      const label =
        NETTO_LABEL_BEFORE.exec(remainder.slice(Math.max(0, amount.start - 24), amount.start))?.[1] ??
        NETTO_LABEL_AFTER.exec(remainder.slice(amount.end, amount.end + 16))?.[1];
      out.push(label ? { why: 'netto', text: `${label} ${text}`, figure: text, number } : { why: 'weight', text, figure: text, number });
    } else {
      out.push({ why: unit === 'm3' ? 'volume' : 'row', text, figure: text, number });
    }
  }
  return out;
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
 * Its home is intake-manual.ts, so the reading's totals parser asks the very
 * same form (as-built review CHAT-3).
 */
const MATERIAL_ADDRESS = MATERIAL_ROW_ADDRESS;

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

/**
 * A measure's LABEL as one token — «MEAS», «Measurement», «G.W.», «毛重»,
 * «体积» — says which figure, never which goods (T3, dg3-08: «MEAS: 5.92
 * CBM» typed at the table was «“MEAS” — jadvalda bunday qator yo‘q»). Only
 * the labels that can name nothing but that measure (units.ts
 * `UNIT_FREE_LABELS`, review JN-21): «net», «gross», «vol», «cube», «вес» are
 * product nouns too, and a row may be addressed by one — «Net 30 dona».
 */
const MEASURE_LABELS = [...UNIT_FREE_LABELS.weightKg, ...UNIT_FREE_LABELS.netKg, ...UNIT_FREE_LABELS.volumeM3].filter(
  (label) => !label.includes(' '),
);
const MEASURE_LABEL_TOKEN = new RegExp(`^(?:${labelPattern(MEASURE_LABELS)})$`, 'iu');
/** A Han label is written glued to its figure («毛重507kg»): taken out of the text, longest first («总毛重» before «毛重»). */
const HAN_LABELS = [...WEIGHT_LABELS, ...NET_LABELS, ...VOLUME_LABELS]
  .filter((label) => /^\p{Script=Han}+$/u.test(label))
  .sort((a, b) => b.length - a.length)
  .join('|');
const HAN_MEASURE_LABEL = new RegExp(HAN_LABELS, 'gu');
/** …and asked for, without a global regex's memory of where it last looked. */
const HAS_HAN_MEASURE_LABEL = new RegExp(HAN_LABELS, 'u');

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
  // «5.9 cubic meters»: a unit of two words is one unit, never a goods name.
  const text = joinUnitPhrases(raw)
    .replace(ENGINE_FIELD, ' ')
    .replace(HAN_MEASURE_LABEL, ' ')
    .replace(GROUPED, (_m, head: string, groups: string) => head + groups.replace(/\s/gu, ''))
    // «1'200 dona»: the apostrophe sets a digit group off — one figure, never a model «1200» of the name (T14).
    .replace(/(?<=\d)['’ʼʻ](?=\d{3}(?!\d))/gu, '')
    // …and a comma between two digits is the number's own — «2,5 kg», «1,136.5 kg»: the tokens
    // below are cut at commas, and «Kurtka 2,5 kg» was «2» of the NAME and a «5 kg» of another row.
    .replace(/(?<=\d),(?=\d)/gu, '.')
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
  // A tonne or a gram in a spelling that can be nothing else is the figure's unit too (T14) —
  // never a lone «t» / «g», which names a model as often («5 t domkrat»).
  const isUnit = (t: string) => unitOf(t) !== null || unitOf(foldName(t)) !== null || scaledKg(t)?.lone === false;
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
    if (MEASURE_LABEL_TOKEN.test(token)) return;
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

/**
 * A segment the seller labelled NETTO — the row's own weight, never the brutto
 * total. The labels are the vocabulary's (units.ts `NET_LABELS`: «N/W», «净重»
 * were on no list here), and «sof» alone.
 */
const NETTO_FIRST = new RegExp(`^\\s*(?:${labelPattern(NET_LABELS)}|sof)(?![\\p{L}])`, 'iu');

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

/**
 * T3: is the segment a figure and a WORD THAT IS NO UNIT, and nothing that
 * names goods beside it — «5.9 kubik», «507 kg 5.9 kubik», «300 banka»? Then
 * the word is asked as a unit. Every goods word the segment holds must be
 * such a word: «Shapka 5 banka» names a product, and «iPhone 15 Pro 30 dona»
 * a model — those keep the refusal they had.
 */
function unitAsked(text: string, parts: NameParts): UnitAsk | null {
  const unknown = unknownUnits(figureText(text));
  if (unknown.length === 0) return null;
  const keys = new Set(unknown.map((u) => foldName(u.word).replace(/[^\p{L}]/gu, '')));
  return [...parts.words, ...parts.han].every((w) => keys.has(w)) ? unknown[0]! : null;
}

interface ReadSegment extends TableSegment {
  /** Addressed by a number, a sign or a totals word — what the material stage takes. */
  explicit: boolean;
  /** A goods-word segment that named no row (rule 3's evidence of a typed goods list). */
  namedNone: boolean;
  /**
   * The part of a totals answer no total took (T2), as a refusal of its own
   * beside the totals that WERE written: «jami 507 kg 300 dona» writes the
   * kilos and says the count went nowhere — neither half is lost to the other.
   */
  also?: ReadSegment;
}

/**
 * A totals reading as the segment(s) it becomes: the totals written, what was
 * left named beside them — or, with nothing a total could take, the refusal
 * alone (with the figures it is about, when there are any to name).
 */
function totalsSegment(raw: string, reading: TotalsReading, flags: { explicit: boolean; namedNone: boolean }): ReadSegment {
  const detail = reading.left.map((l) => l.text).join(', ');
  if (reading.totals === null) {
    const whole = refused(raw, 'totals_unit', raw);
    return reading.left.length > 0
      ? { ...whole, refused: { reason: 'totals_unit', detail, left: reading.left }, ...flags }
      : { ...whole, ...flags };
  }
  const placed: ReadSegment = { raw, at: totalsTarget(reading.totals), refused: null, answer: null, totals: reading.totals, route: null, ...flags };
  if (reading.left.length === 0) return placed;
  return {
    ...placed,
    also: { ...refused(detail, 'totals_unit', detail), refused: { reason: 'totals_unit', detail, left: reading.left }, ...flags },
  };
}

/** A row's folded name — `rowName`, or one the caller already folded (`nameWordFor`, perf review PERF-1). */
type NameOf = (row: TableRow) => RowName;
const foldEach: NameOf = (row) => rowName(row.name);

function readSegment(raw: string, table: TableRef, nameOf: NameOf): ReadSegment {
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
      const name = nameOf(row);
      if (!namesRow(parts, name) || !holdsModel(parts, name)) {
        const unit = unitAsked(address.rest, parts);
        return {
          ...refused(raw, 'name_mismatch', parts.typed || raw, { at: { line: row.no }, answer }),
          refused: { reason: 'name_mismatch', detail: parts.typed || raw, candidates: [row.no], ...(unit ? { unit } : {}) },
          explicit: true,
          namedNone: false,
        };
      }
    }
    return { raw, at: { line: row.no }, refused: null, answer, totals: null, route: null, explicit: true, namedNone: false };
  }

  const lead = totalsLead(raw);
  if (lead) return totalsSegment(raw, readTotals(lead.rest, lead.field, table.open), { explicit: true, namedNone: false });

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
    // What the row kernel cannot read as ONE row's answer may still be the
    // shipment's own line: two kilos, a brutto and a netto («G.W.: 507 KGS
    // N.W.: 480 KGS MEAS: 5.92 CBM»), a weight in a lone letter after its
    // label («G.W. 2.5 MT»), or a Han label glued to its figure («毛重507kg» —
    // no amount to a reader that never splits letters from digits). The
    // totals reader takes what it can and names the rest (T2).
    const loneScaled = answer.kind === 'refused' && answer.reason === 'unknown_unit' && scaledKg(answer.detail) !== null;
    if (answer.kind === 'refused' && (answer.reason === 'repeated' || loneScaled || HAS_HAN_MEASURE_LABEL.test(raw))) {
      const typed = readTotals(raw, null, table.open);
      if (typed.totals !== null || typed.left.length > 0) return totalsSegment(raw, typed, plain);
    }
    if (answer.kind === 'refused') {
      // «5 kb»: a word too short to be anybody's name, and no unit either.
      const unit = answer.reason === 'unknown_unit' ? unitAsked(raw, parts) : null;
      const none = refused(raw, 'no_address', raw);
      return { ...none, ...(unit ? { refused: { ...none.refused!, unit } } : {}), ...plain };
    }
    const target = targetFor(answer, table, NETTO_FIRST.test(raw));
    if (target === null) return { ...refused(raw, 'no_address', raw, { answer }), ...plain };
    if (target === 'both' || 'totals' in target) {
      const read = totalsSegment(raw, readTotals(raw, target === 'both' ? null : target.totals, table.open), plain);
      // A bare figure is the one total the table had open for it.
      return target === 'both' || read.refused ? read : { ...read, at: target };
    }
    return { raw, at: target, refused: null, answer, totals: null, route: null, ...plain };
  }

  // Goods words: the NAME address, read before or after the figure («50 dona
  // sumka», «40 juft krossovka» — ordinary Uzbek word order, product-fit-13).
  const met = table.rows.filter((r) => namesRow(parts, nameOf(r)));
  if (met.length === 0) {
    const unit = unitAsked(raw, parts);
    const none = refused(raw, 'name_none', parts.typed || raw, { answer });
    return { ...none, ...(unit ? { refused: { ...none.refused!, unit } } : {}), explicit: false, namedNone: true };
  }
  const kept = met.filter((r) => holdsModel(parts, nameOf(r)));
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
 * The rows' folded names per table — `answerHow` asks up to NAME_ROWS_TRIED
 * rows of ONE `rows` array, so a render folds them once (perf review PERF-1).
 * Keyed by the array itself: a new render builds a new one, and nothing is held.
 */
const FOLDED_ROWS = new WeakMap<readonly TableRow[], RowName[]>();

/** A number (decimals, «1 200» grouping) with a word after it — a figure when that word is a unit. */
const FIGURE_IN_NAME = /(?<![\p{L}\p{N}])\d+(?:[.,]\d+)*(?:\s\d{3}(?!\d))*\s+(\p{L}[\p{L}²³]*)/gu;

/** At most this many leading WORDS make an example name — past three it is no example anyone types. */
const NAME_WORDS_TAUGHT = 3;

/**
 * The words of `row`'s name a typed answer names it by ALONE among `rows`, by
 * `readSegment`'s own rule: the shortest leading run of its words — «Kurtka»
 * when it is the only kurtka, «Kurtka qishki ayollar» beside «Kurtka qishki
 * erkaklar» — or null when no run of up to three words does. What the
 * table's ✍️ line teaches (intake.ts `answerHow`, review PF-4): its example
 * «Kurtka 30 dona» over two kurtka rows was the parser's own «name_many».
 *
 * A run starts with a word of three letters («100% paxta futbolka» gave «100
 * 30 dona», which reads as row 100 — review adv-20) and keeps the model's
 * numbers between its words: «iPhone Pro» taught for «iPhone 15 Pro» named
 * goods no row holds (fix review W-9). A number with its unit word after it
 * — «1.5 litr» and «1 200 dona» whole (`FIGURE_IN_NAME`) — is a FIGURE
 * inside the name, and the pair is left out of the run: «Paket
 * 100 dona qora» taught «Paket 100 dona qora 30 dona», which the parser
 * refuses «repeated» — and «Paypoq 10 juft qora 30 dona» wrote 10 juft as a
 * measure beside the 30 (the fix review's check, CHK-1). The candidates are
 * prefiltered by every rule `readSegment` asks before the name — a totals
 * word first («Jami to‘plam 30 dona» is refused «totals_unit»; «TOTAL drel
 * 150 kg» was read as the brutto), a carton word («Qop polipropilen 30 dona»
 * — no_address), an address — and the name match over the folded rows (fix
 * review FR-6); the one that names this row alone is then read back by
 * `parseTableAnswer` itself, exactly as the ✍️ line draws it (`exampleFigure`
 * of the row's first need), and taught only when it lands on this row with
 * the example's own figure and nothing else. The parser is the arbiter: a
 * rule restated here beside it is how W-9's fix taught what CHK-1 found. The
 * rows' names are folded once per call (fix review FR-3: a rowName per row
 * per candidate per ⚠️ row was seconds on a 500-row table), and the parser
 * reads only a candidate that already named this row alone — at most
 * NAME_WORDS_TAUGHT per call — over those same folded names (`readTable`,
 * perf review PERF-1: a fold of its own per candidate was 0.4-1.2 s a render
 * on 1000 long customs descriptions).
 */
export function nameWordFor(rows: readonly TableRow[], row: TableRow): string | null {
  // «100 dona», «1.5 litr», «1 200 dona»: a figure in the name, never its words.
  const bare = row.name.replace(FIGURE_IN_NAME, (whole, unit: string) => (unitOf(unit) !== null ? ' ' : whole));
  const tokens = bare.match(/(?<![\p{L}\p{N}])[\p{L}\p{N}][\p{L}\p{N}'’‘ʻ`-]*/gu) ?? [];
  const isWord = (t: string) => /^\p{L}[\p{L}\p{N}'’‘ʻ`-]{2,}$/u.test(t);
  const candidates: string[] = [];
  const run: string[] = [];
  for (const token of tokens) {
    if (isWord(token)) {
      run.push(token);
      candidates.push(run.join(' '));
      if (candidates.length >= NAME_WORDS_TAUGHT) break;
    } else if (run.length > 0 && /^\d+$/u.test(token)) run.push(token);
  }
  // The figure the ✍️ line draws after the name (intake.ts `answerHow`), and
  // what that figure alone reads as — the answer the example must carry.
  const figure = exampleFigure(row.needs[0] ?? 'dona');
  const expected = JSON.stringify(parseLineAnswer(figure));
  const ref: TableRef = { rows, open: [], preferred: [], stage: 'review' };
  let names: RowName[] | null = null;
  // The parser reads with the names folded here (perf review PERF-1: its own
  // fold per candidate was 0.4-1.2 s a render on 1000 long customs names).
  let folded: Map<TableRow, RowName> | null = null;
  const nameOf: NameOf = (r) => folded!.get(r) ?? rowName(r.name);
  const foldRows = () => {
    const known = FOLDED_ROWS.get(rows);
    if (known) return known;
    const fresh = rows.map((r) => rowName(r.name));
    FOLDED_ROWS.set(rows, fresh);
    return fresh;
  };
  for (const candidate of candidates) {
    const example = `${candidate} ${figure}`;
    if (addressOf(example, 'review') !== null || totalsLead(example) !== null) continue;
    const parts = nameParts(example);
    if (parts.carton || !hasName(parts)) continue;
    names ??= foldRows();
    const named = rows.filter((_, i) => namesRow(parts, names![i]!) && holdsModel(parts, names![i]!));
    if (named.length !== 1 || named[0]!.no !== row.no) continue;
    folded ??= new Map(rows.map((r, i) => [r, names![i]!]));
    const read = readTable(example, ref, nameOf);
    const [segment] = read.segments;
    const lands =
      !read.material &&
      read.segments.length === 1 &&
      segment!.refused === null &&
      segment!.at !== null &&
      'line' in segment!.at &&
      segment!.at.line === row.no &&
      JSON.stringify(segment!.answer) === expected;
    if (lands) return candidate;
  }
  return null;
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
  return readTable(text, table, foldEach);
}

/** Every segment of a text, read against the table — `readTable`'s and `materialSegments`' one reading. */
function readAll(text: string, table: TableRef, nameOf: NameOf): ReadSegment[] {
  const startsAddressed = (part: string): boolean =>
    addressOf(part, table.stage) !== null ||
    totalsLead(part) !== null ||
    (table.stage === 'review' && hasName(nameParts(part)) && table.rows.some((r) => namesRow(nameParts(part), nameOf(r))));
  return segmentsOf(text, startsAddressed).flatMap((raw) => {
    const read = readSegment(raw, table, nameOf);
    return read.also ? [read, read.also] : [read];
  });
}

const strip = (s: ReadSegment): TableSegment => ({
  raw: s.raw,
  at: s.at,
  refused: s.refused,
  answer: s.answer,
  totals: s.totals,
  route: s.route,
});

/**
 * In the material stage a segment ANSWERS only when it is explicitly
 * addressed and names no other goods: «1: Kurtka 300 dona» typed after «➕
 * Yana ma’lumot» is the seller's list, never a correction of row 1. ONE
 * predicate for the whole-text rule and the per-segment one.
 */
const placedInMaterial = (s: ReadSegment): boolean => s.explicit && s.refused?.reason !== 'name_mismatch';

/**
 * The material stage's reading, per SEGMENT — every segment with whether the
 * stage's rule places it (`placedInMaterial`). For the AI door collecting
 * after a reading (as-built review CHAT-2): «3: 150 kg\nrahmat» is a placed
 * row answer and a courtesy word, never one piece of material whose 150 kg
 * becomes the shipment's; what is not placed is the caller's to file. Pure.
 */
export function materialSegments(text: string, table: TableRef): { segment: TableSegment; placed: boolean }[] {
  const at = table.stage === 'material' ? table : { ...table, stage: 'material' as const };
  return readAll(text, at, foldEach).map((s) => ({ segment: strip(s), placed: placedInMaterial(s) }));
}

/** `parseTableAnswer` with the rows' names folded by `nameOf` — the ONE reader; only the fold is the caller's. */
function readTable(text: string, table: TableRef, nameOf: NameOf): { segments: TableSegment[]; material: boolean } {
  const read = readAll(text, table, nameOf);
  if (table.stage === 'material') {
    // Answers only when every segment is placed (`placedInMaterial`).
    const answers = read.length > 0 && read.every(placedInMaterial);
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
  return lead !== null && lead.rest !== '' && totalsShape(lead.rest) !== null;
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
    segments.every((s) => totalsShape(s) === 'worded' || totalsWordAnswer(s) || lineAnswerSegment(s))
  );
}
