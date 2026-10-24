import { normalizeDigits } from './digits';

/**
 * G1 by KIND and SOURCE (review money-1).
 *
 * The first design asked whether a number's VALUE was in a set of «allowed»
 * values — and the set held the persona phone's 998/95/018, the kb's street
 * numbers and the customer's own «90 qilib bering», so any of them could be
 * printed beside «$» as a price and pass. A number is now read with the word
 * beside it: money, a measure, a duration, a date, a count, a percent, or a
 * bare figure. A MONEY number passes only when a MONEY source of this run
 * holds it (the yo'lkira tool's figure, the customer's own balance, the offer
 * he typed); a measure only from a measure source (the customer's message, a
 * tool); and so on. Phones and approved links are taken out WHOLE before any
 * of this, so their digits are never figures.
 *
 * Pure. Every card prints the ledger this builds — each figure beside the
 * source that let it through — so the owner sees what he is approving.
 */

export type NumberKind = 'money' | 'measure' | 'duration' | 'date' | 'count' | 'percent' | 'plain';

export interface FoundNumber {
  raw: string;
  value: number;
  kind: NumberKind;
  index: number;
}

export interface NumberSource {
  value: number;
  /** The kind this source vouches for. A customer's money figure is never a money source (`customer_money`). */
  kind: NumberKind | 'customer_money';
  /** Shown on the card's «🔢 Raqamlar» line. */
  label: string;
}

export interface LedgerEntry {
  raw: string;
  kind: NumberKind;
  /** The source that let it through, or null — a null is a G1 block. */
  source: string | null;
}

/** A phone in any spelling: an optional +, then ≥ 9 digits with spaces, dashes, dots or brackets between. */
export const PHONE_RE = /\+?\d(?:[\s\-.()]*\d){8,}/gu;

/** Digits only — how two phones are compared. */
export function phoneDigits(raw: string): string {
  return raw.replace(/\D/gu, '');
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+|\b[a-z0-9-]+\.(?:uz|ru|com|cn|net|org|io|me|app|ir|af)\/[^\s<>()]*/giu;

export function urlsIn(text: string): string[] {
  return [...text.matchAll(URL_RE)].map((m) => m[0].replace(/[.,!?)»]+$/u, ''));
}

const MONEY_AFTER =
  /^\s*(?:\$|usd\b|us\$|dollar\w*|доллар\w*|долл\.?|so['‘’ʻ]?m\b|сўм\w*|сум\w*|yuan\b|юан\w*|元|美元|块|美金|دلار|تومان|افغانی)/iu;
const MONEY_BEFORE = /(?:\$|usd|us\$)\s*$/iu;
const MEASURE_AFTER =
  /^\s*(?:kg\b|кг\b|kilo\w*|кило\w*|kub\w*|куб\w*|m3\b|м3\b|m³|м³|tonna\w*|тонн\w*|公斤|千克|吨|立方|کیلو\w*|متر\s*مکعب|کیلوگرم)/iu;
const DURATION_AFTER =
  /^\s*(?:kun\w*|кун\w*|день|дн[яейь]\w*|сут\w*|day\w*|天|日|روز|hafta\w*|ҳафта\w*|недел\w*|week\w*|周|星期|هفته|soat\w*|соат\w*|час\w*|hour\w*|小时|ساعت|oy\b|ой\b|месяц\w*|month\w*|个月|ماه|daqiqa\w*|дақиқа\w*|минут\w*|minute\w*|分钟|دقیقه)/iu;
const COUNT_AFTER =
  /^\s*(?:ta\b|та\b|dona\w*|дона\w*|шт\w*|штук\w*|pcs\b|piece\w*|karobka\w*|коробк\w*|box\w*|carton\w*|件|个|箱|عدد|کارتن|جعبه|mesta\b|мест\w*|joy\b|quti\w*|қути\w*)/iu;
const PERCENT_AFTER = /^\s*(?:%|٪|foiz\w*|фоиз\w*|процент\w*|percent\w*)/iu;
const MONTH_AFTER =
  /^\s*-?\s*(?:yanvar|fevral|mart|aprel|may|iyun|iyul|avgust|sentabr|oktabr|noyabr|dekabr|январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec|月)/iu;
/** A range: «15-25 kun», «15 dan 25 gacha», «15 до 25». The unit after the second number names both. */
const RANGE_TAIL = /^\s*(?:[-–—~]|dan|до|to|تا|到|至)\s*\d+(?:[.,]\d+)?(?:\s*(?:gacha|гача))?/iu;

/** A figure as written: thousands by space, comma or dot groups of three, decimals by dot or comma. */
const NUMBER_RE = /\d{1,3}(?:[ ,. ]\d{3})+(?![\d])(?:[.,]\d+)?|\d+(?:[.,]\d+)?/gu;
/** dd.mm(.yyyy) with a two-digit month — the spelling every date the system prints uses («dd.MM»). */
const DATE_RE = /(?<!\d)(\d{1,2})[./](\d{2})(?:[./](\d{2,4}))?(?!\d)/gu;
const TIME_RE = /(?<!\d)\d{1,2}:\d{2}(?!\d)/gu;

/** «1 200», «1,200», «1.200» → 1200; «1,5» → 1.5; «330.50» → 330.5. */
export function parseFigure(raw: string): number {
  const s = raw.replace(/ /gu, ' ');
  // Groups of exactly three after a separator are thousands.
  if (/^\d{1,3}(?:[ ,.]\d{3})+$/u.test(s)) return Number(s.replace(/[ ,.]/gu, ''));
  const grouped = /^(\d{1,3}(?:[ ,.]\d{3})+)([.,]\d+)$/u.exec(s);
  if (grouped) return Number(`${grouped[1]!.replace(/[ ,.]/gu, '')}.${grouped[2]!.slice(1)}`);
  return Number(s.replace(',', '.'));
}

function kindAt(text: string, start: number, end: number): NumberKind {
  const before = text.slice(Math.max(0, start - 6), start);
  if (MONEY_BEFORE.test(before)) return 'money';
  let tail = text.slice(end, end + 40);
  const range = RANGE_TAIL.exec(tail);
  if (range) tail = tail.slice(range[0].length);
  if (PERCENT_AFTER.test(tail)) return 'percent';
  if (MONEY_AFTER.test(tail)) return 'money';
  if (MEASURE_AFTER.test(tail)) return 'measure';
  if (DURATION_AFTER.test(tail)) return 'duration';
  if (MONTH_AFTER.test(tail)) return 'date';
  if (COUNT_AFTER.test(tail)) return 'count';
  return 'plain';
}

/**
 * Every figure in a text, with its kind. `removeWhole` are strings taken out
 * before anything is read (the persona phone, an approved link) — whole, so
 * their digits are never figures. Phones are always taken out; the caller
 * judges them separately (G6).
 */
export function extractNumbers(text: string, removeWhole: readonly string[] = []): FoundNumber[] {
  let t = normalizeDigits(text);
  for (const r of removeWhole) {
    if (r) t = t.split(normalizeDigits(r)).join(' '.repeat(r.length));
  }
  for (const u of urlsIn(t)) t = t.split(u).join(' '.repeat(u.length));
  t = t.replace(PHONE_RE, (m) => ' '.repeat(m.length));
  const out: FoundNumber[] = [];
  const taken: [number, number][] = [];
  for (const m of t.matchAll(DATE_RE)) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    // «1.50 kg», «12.50 $» are figures with a unit, not the first of May.
    if (kindAt(t, m.index, m.index + m[0].length) !== 'plain') continue;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      out.push({ raw: m[0], value: day * 100 + month, kind: 'date', index: m.index });
      taken.push([m.index, m.index + m[0].length]);
    }
  }
  for (const m of t.matchAll(TIME_RE)) {
    if (taken.some(([a, b]) => m.index >= a && m.index < b)) continue;
    out.push({ raw: m[0], value: Number(m[0].replace(':', '.')), kind: 'plain', index: m.index });
    taken.push([m.index, m.index + m[0].length]);
  }
  for (const m of t.matchAll(NUMBER_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (taken.some(([a, b]) => start < b && end > a)) continue;
    // A digit glued to letters is part of a code («GS777», «B-000124»), not a figure — G6 judges codes.
    const prev = t[start - 1];
    if (prev !== undefined && /[\p{L}]/u.test(prev) && !/[\p{Script=Han}]/u.test(prev)) continue;
    if (prev === '-' && /[\p{L}]/u.test(t[start - 2] ?? '')) continue;
    const value = parseFigure(m[0]);
    if (!Number.isFinite(value)) continue;
    out.push({ raw: m[0], value, kind: kindAt(t, start, end), index: start });
  }
  return out.sort((a, b) => a.index - b.index);
}

function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

/**
 * Which source lets a figure through, or null. A money figure needs a money
 * source and nothing else will do; every other kind takes a source of its
 * own kind, and a bare figure takes any source but the customer's money.
 */
export function sourceFor(found: FoundNumber, sources: readonly NumberSource[]): NumberSource | null {
  const fits = (s: NumberSource) => {
    if (!sameValue(s.value, found.value)) return false;
    if (s.kind === 'customer_money') return false;
    if (found.kind === 'money') return s.kind === 'money';
    if (found.kind === 'plain') return true;
    // A measure can be stated as a bare count of the same thing and vice versa.
    if (found.kind === 'count') return s.kind === 'count' || s.kind === 'measure' || s.kind === 'plain';
    return s.kind === found.kind || s.kind === 'plain';
  };
  return sources.find(fits) ?? null;
}

/** The ledger for one text: each figure beside the source that let it through. */
export function numberLedger(
  text: string,
  sources: readonly NumberSource[],
  removeWhole: readonly string[] = [],
): LedgerEntry[] {
  return extractNumbers(text, removeWhole).map((f) => ({
    raw: f.raw,
    kind: f.kind,
    source: sourceFor(f, sources)?.label ?? null,
  }));
}

/**
 * Sources from text the CUSTOMER wrote: every figure of theirs vouches for
 * itself as a measure, a count, a duration — but a money figure of theirs
 * («90$ qilib bering») is a request, never a price we may repeat as ours.
 */
export function customerSources(texts: readonly { text: string; label: string }[]): NumberSource[] {
  const out: NumberSource[] = [];
  for (const { text, label } of texts) {
    for (const f of extractNumbers(text)) {
      out.push({ value: f.value, kind: f.kind === 'money' ? 'customer_money' : f.kind, label });
    }
  }
  return out;
}
