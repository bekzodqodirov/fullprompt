import { b, clipText, groupDigits, h, usd, visibleLength } from '../../platform/telegram/format';
import type { ChildState } from './chain';

/**
 * The price channel's POST — what the staff read when a price is given (the
 * owner's F, 2026-10-07: «har bir berilgan narx kanalga tushsin»).
 *
 * PURE, and shaped by what it must NEVER carry. His answers fix the body: the
 * total, the goods names, kg/kub and ONE $/kg or $/kub (F2 a); no client at
 * all — no code, no name, never a phone (F4 a); the seller whose request it
 * was is NAMED (F9 b). So the view is a projection TYPE with no field a client,
 * a floor breakdown, a discount or a note could ride in
 * (`tests/unit/price-channel-post.test.ts` pins its keys), and the builder
 * (channel-queue.ts) is the only thing that reads the card — through
 * `scrubIdentity`, never into the view.
 *
 * No button and no link of any kind: `/bitimlar/[id]` has no ownership gate,
 * and the post is for every colleague (F10 a: no «use this price» door).
 */

/** The post's own vocabulary — the 0128 CHECK lists and the panel's words are written from these (#163). */
export const POST_KINDS = ['seal', 'answer'] as const;
export type PostKind = (typeof POST_KINDS)[number];
export const POST_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'] as const;
export type PostStatus = (typeof POST_STATUSES)[number];
export const SKIP_REASONS = ['no_channel', 'discount', 'band_override', 'channel_changed', 'stale'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
/** The two `last_error` values the panel translates; any other is printed raw. */
export const FAIL_REASONS = ['stuck_sending', 'ambiguous_send'] as const;
export type FailReason = (typeof FAIL_REASONS)[number];

/** The caption ceiling — a post with photos IS the album's caption, and one ceiling lets one renderer edit both. */
export const CHANNEL_POST_MAX = 1024;

export type ChannelSection = 'yolkira' | 'rastamojka' | 'podklyuch';

export interface ChannelPostView {
  kind: PostKind;
  section: ChannelSection | null;
  /** «V2» — seals only (`quoteNoFor`). */
  quoteNo: number | null;
  /** YYYY-MM-DD, Tashkent, of sealed_at / completed_at. */
  day: string;
  /** seal: valid_until; answer: completed_at + quote_valid_days. */
  validUntilDay: string | null;
  /** Scrubbed names, each clipped to 40 code points. */
  goods: string[];
  /** How many names were not printed. */
  goodsMore: number;
  weightKg: number | null;
  volumeM3: number | null;
  amount: number;
  currency: 'USD' | 'UZS' | 'CNY';
  perUnit: { value: number; unit: 'kg' | 'm3' } | null;
  /** F9 b — requested_by (the ROOT seller on a correction). */
  sellerName: string;
  /** Who priced it (credit.ts). */
  vedName: string | null;
  /** A correction: the V it replaces (null when the parent was an answer). */
  replacesQuoteNo: number | null;
  isCorrection: boolean;
}

/** How a post that no longer stands is marked: the parent's child state, and whether the child was posted. */
export interface PostMark {
  state: ChildState;
  childPosted: boolean;
}

/**
 * The first line of a post that no longer stands. Indexed by the whole
 * `ChildState` union, so the day chain.ts grows a sixth ending the compiler
 * names this map. `sealed`/`answered` here are the lines for a correction that
 * WAS posted (a reply sits under the old post); `REPRICED_UNPOSTED` is for one
 * that was not.
 */
export const MARK_LINES: Record<ChildState, string> = {
  open: `🔄 ${b('QAYTA HISOBLANMOQDA')} — bu narx amal qilmaydi`,
  sealed: `❌ ${b('Bu narx amal qilmaydi')} — yangi narx berildi`,
  answered: `❌ ${b('Bu narx amal qilmaydi')} — o‘rniga qo‘lda narx berildi`,
  returned: `❌ ${b('Bu narx amal qilmaydi')} — qayta hisoblash qaytarildi`,
  unpriced: `❌ ${b('Bu narx amal qilmaydi')} — qayta hisoblash narxsiz yopildi`,
};

/**
 * A correction that was NOT posted — skipped for a discount or a band override
 * (F3 a), for no channel, as stale, or failed. «yangi narx berildi» would send
 * every reader looking for a reply that is not there, and the line must never
 * name a discount (F3's own reason for not posting it).
 */
export const REPRICED_UNPOSTED = `❌ ${b('Bu narx amal qilmaydi')} — qayta hisoblandi`;

export function markLine(mark: PostMark): string {
  if ((mark.state === 'sealed' || mark.state === 'answered') && !mark.childPosted) return REPRICED_UNPOSTED;
  return MARK_LINES[mark.state];
}

/** A child post's state as the reconcile sees it. */
export type ChildPosted = 'posted' | 'waiting' | 'unposted';

/**
 * Was the correction that replaced a post itself posted? Asked only for a
 * correction that ended with a price (`sealed`/`answered`): a post still in
 * flight is `waiting` (the parent is not edited this run, or it would say
 * «qayta hisoblandi» a minute before the reply appears), and so is a child
 * that ended less than ten minutes ago with no row yet — the hook or the net
 * has not run.
 */
export function childPostedFor(o: {
  state: ChildState;
  childPostStatus: PostStatus | null;
  childCompletedAt: Date | null;
  now: Date;
}): ChildPosted {
  if (o.state !== 'sealed' && o.state !== 'answered') return 'unposted';
  if (o.childPostStatus === 'sent') return 'posted';
  if (o.childPostStatus === 'pending' || o.childPostStatus === 'sending') return 'waiting';
  if (o.childPostStatus === null && o.childCompletedAt && o.now.getTime() - o.childCompletedAt.getTime() < 10 * 60_000) {
    return 'waiting';
  }
  return 'unposted';
}

/**
 * ONE per-unit figure (F2 a). Freight decides for a yolkira or podklyuch job —
 * only the open-ended top band is charged by weight (tariff-seed.ts), so that
 * is the unit the customer pays freight in; customs follows the declaration,
 * and 74 % of his import file is per-kg. The other unit when the first is
 * missing; nothing for a so‘m or yuan answer (a so‘m per kilo is a different
 * sentence).
 */
export function pickPerUnit(o: {
  section: ChannelSection | null;
  bandPerKg: boolean | null;
  perKg: number | null;
  perM3: number | null;
  currency: string;
}): { value: number; unit: 'kg' | 'm3' } | null {
  if (o.currency !== 'USD') return null;
  const usable = (v: number | null): v is number => v !== null && Number.isFinite(v) && v > 0;
  const freightFirst = o.section === 'yolkira' || o.section === 'podklyuch';
  const order: ('kg' | 'm3')[] = freightFirst && o.bandPerKg !== true ? ['m3', 'kg'] : ['kg', 'm3'];
  for (const unit of order) {
    const value = unit === 'kg' ? o.perKg : o.perM3;
    if (usable(value)) return { value, unit };
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * What the scrub is told — every list REQUIRED, so the builder that forgets
 * one is a compile error and never a quiet leak.
 */
export interface ScrubContext {
  /** The card's PEOPLE: the client's name and phones, the lead's name, company and phone — removed word by word. */
  forbidden: readonly string[];
  /** The card's own CODES (its deal's, its client's) — removed as whole units at ANY length. */
  ownCodes: readonly string[];
  /** The client-code prefix setting as it stands today. */
  codePrefix: string;
  /** Client codes of the BOOK that these names carry (`codeCandidates` → `clients`). */
  knownCodes: ReadonlySet<string>;
  /** Unclaimed markings these names carry — free text, so matched by data, never by shape. */
  markings: readonly string[];
}

/**
 * The Cyrillic letters a code is mistyped with — one UTF-16 unit to one, so
 * every index of the folded shadow is an index of the name (the splice below
 * depends on it). Б is not here: it is the deal letter SPELLED in Cyrillic,
 * not a look-alike, and the deal shape names it.
 */
const LOOKALIKE: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X',
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', х: 'x',
};

function fold(s: string): string {
  return s.replace(/[АВЕКМНОРСТХавекмнорстх]/gu, (c) => LOOKALIKE[c] ?? c);
}

/**
 * NFKC — a Chinese IME types `ＧＳ７７７` — except across `№`, which NFKC
 * rewrites to the two LETTERS «No» and so would weld itself to the code it
 * labels. Stated cost: `m²` reads `m2`.
 */
function nfkc(s: string): string {
  return s
    .split('№')
    .map((part) => part.normalize('NFKC'))
    .join('№');
}

/** How a Latin code prefix is spelled in Cyrillic (GS → ГС); the scrub folds it like the name. */
const CYRILLIC_SPELLING: Record<string, string> = {
  A: 'А', B: 'Б', C: 'С', D: 'Д', E: 'Е', F: 'Ф', G: 'Г', H: 'Х', I: 'И', J: 'Ж', K: 'К', L: 'Л', M: 'М',
  N: 'Н', O: 'О', P: 'П', Q: 'К', R: 'Р', S: 'С', T: 'Т', U: 'У', V: 'В', W: 'В', X: 'Х', Y: 'Й', Z: 'З',
};

/** A word edge — letters and digits of every script; never JS `\b`, which is ASCII-only (round 37). */
const EDGE_BEFORE = '(?<![\\p{L}\\p{N}])';
const EDGE_AFTER = '(?![\\p{L}\\p{N}])';
interface Edges {
  before: string;
  after: string;
}
const WORD_EDGES: Edges = { before: EDGE_BEFORE, after: EDGE_AFTER };
/**
 * A CODE's edge: the word edge, except that CJK script is not part of a
 * code's word. Chinese is written with no spaces, so «男士夹克GS777» is a code
 * standing between edges for every reader but the regex. People's names and
 * markings keep the plain edge — a name glued to Chinese is a stated residual.
 */
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const CODE_EDGES: Edges = {
  before: `(?<!(?![${CJK}])[\\p{L}\\p{N}])`,
  after: `(?!(?![${CJK}])[\\p{L}\\p{N}])`,
};
/** A letter / letter-or-digit a code may run on with — never a CJK one, or «GS777-男士夹克» takes the goods with it. */
const CODE_LETTER = `(?:(?![${CJK}])\\p{L})`;
const CODE_ALNUM = `(?:(?![${CJK}])[\\p{L}\\p{N}])`;
/** What a person puts between a code's letters and its digits: `GS 555`, `GS-555`, `GS#555`. */
const SEAM = '[\\s\\-_.#№]?';
/** The search's lot form, `GS777-A`. */
const LOT = `(?:\\s?-\\s?${CODE_LETTER}{1,2})?`;
/**
 * What is glued to a code with `-`, `_` or `.` — `GS555-Bobur`, `GS555_Ali`.
 * The old token rule dropped the whole token; cutting the bare code would
 * hand the reader the person glued to it.
 */
const GLUED = `(?:[-_.]${CODE_ALNUM}+)*`;

/**
 * An all-digit code is also a QUANTITY: «Suv 500 ml», «Lampa 220 V», «Pena
 * 111 x 50». Such a number is a code only when no unit follows it, no «x»
 * stands before it, and it is not a part of a bigger number (`1.500`,
 * `500.5`). The units are folded like the shadow, so «мл» meets itself.
 * Stated cost: «444 L» (a size, or a litre) keeps a code 444; «444-L», the
 * lot form, still goes.
 */
const MEASURE_UNITS = [
  'ml', 'мл', 'l', 'л', 'litr', 'литр', 'kg', 'кг', 'g', 'г', 'gr', 'гр', 'gramm', 'грамм', 'm', 'м', 'metr', 'метр',
  'sm', 'см', 'mm', 'мм', 'v', 'в', 'volt', 'w', 'вт', 'gb', 'mb', 'x', '×', 'dona', 'шт', 'sht', 'ta',
];
const UNITS = [...new Set(MEASURE_UNITS.map((u) => escapeRegExp(fold(u))))]
  .sort((a, b) => b.length - a.length)
  .join('|');
const QUANTITY_BEFORE = '(?<![x×*]\\s?)(?<!\\d[.,])';
const QUANTITY_AFTER = `(?![.,]\\d)(?!\\s?(?:(?:${UNITS})${EDGE_AFTER}|[x×*]\\s?\\d|%))`;

/** An all-digit unit wrapped so a quantity is never read as it. */
function asCode(pattern: string, raw: string): string {
  return /^\d+$/u.test(raw) ? `${QUANTITY_BEFORE}${pattern}${QUANTITY_AFTER}` : pattern;
}

/** A code as a pattern over the shadow, a seam allowed wherever a letter meets a digit. */
function codePattern(code: string): string {
  const chars = [...fold(nfkc(code))];
  let out = '';
  chars.forEach((ch, i) => {
    if (i > 0) {
      const prev = chars[i - 1]!;
      const letterDigit = (a: string, b: string) => /\p{L}/u.test(a) && /\p{N}/u.test(b);
      if (letterDigit(prev, ch) || letterDigit(ch, prev)) out += SEAM;
    }
    out += escapeRegExp(ch);
  });
  return out;
}

/**
 * The dropped TOKENS — anything that is a way to a person or a card: a handle,
 * a Telegram link, any URL, a uuid, one of this app's paths, a bare host.
 */
const LINK_TOKEN: readonly RegExp[] = [
  /@/u,
  /t\.me\//iu,
  /:\/\//u,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu,
  /\/(?:bitimlar|crm|admin|receipts|boxes|batches|hisoblash|finance|stock|o)\//iu,
  /[a-z0-9-]+\.(?:uz|ru|com|cn|net|org|io|me|app)(?:\/|$)/iu,
];

/**
 * The SYSTEM's own codes — every one of them opens onto a client for
 * somebody (crate and box in the bot, receipt and deal in ⌘K, a pickup's
 * lines), so each goes by its minted shape. Crate before box: a crate code
 * ends in a box-shaped tail. Run over the shadow, so `В` arrives as `B`.
 *
 * A deal code is `B-` and six digits or more (deals/service.ts pads to six),
 * so «Printer B-400» is a model and «в 100000 шт» a preposition — and the
 * dash-less arm takes no space for the same reason.
 *
 * KEPT on purpose: the batch `YW-045`. A truck carries many clients, its
 * contents sit behind `BATCH_READERS`, and `{PREFIX}-{NNN}` cannot be told
 * from «LED-100» — scrubbing it would eat real goods names.
 */
const SYSTEM_SHAPES: readonly string[] = [
  /* crate   */ 'CR-[A-Za-z0-9]*\\d{2}-\\d{5,}',
  /* box     */ '[A-Za-z][A-Za-z0-9]*\\d{2}-\\d{6,}',
  /* receipt */ '[A-Za-z0-9]+\\s?-\\s?IN\\s?-\\s?\\d{6}\\s?-\\s?\\d+',
  /* pickup  */ 'ZR-\\d{5,}',
  /* deal    */ '[BБ](?:\\s?[-‐‑‒–—_]\\s?\\d{6,}|\\d{6,})',
];

/** The name and its folded shadow — the same length, cut at the same indices. */
interface Text {
  out: string;
  shadow: string;
}

/**
 * Where a cut was: one NUL in place of the removed unit, in both strings, so
 * the remnant pass can tell a separator a cut left standing alone from one
 * the seller typed («Kabel 10 - 20 m»). Postgres text cannot hold a NUL, and
 * the scrub clears any that arrive, so it never comes from a name. No rule
 * reads it as a letter, a digit or a space; the end turns it into a space.
 */
const CUT = '\u0000';
const SEPARATOR = '[-–—_#№:/|]';
/** A separator that touches a cut and frames nothing else: «YW-045 / YW26-000123» → «YW-045». */
const ORPHAN_AT_CUT = new RegExp(
  `(?:(^|\\s)${SEPARATOR}+\\s*|${SEPARATOR}+)?\\u0000(?:\\s*${SEPARATOR}+(?=\\s|$)|${SEPARATOR}+(?=\\s|$))?`,
  'gu',
);

/** A label that hugged a removed code: `kod:GS555`, `код: 444`. */
const HUGGING_LABEL = new RegExp(`${EDGE_BEFORE}(?:kod|${fold('код')}|code)\\s?:\\s?$`, 'iu');

/**
 * Widen a removal over what only existed to frame it — a `#` or `№` glued to
 * its front, a pair of brackets around it, a «kod:» label — so «(GS555)»
 * leaves nothing behind. Never past `floor` (the previous cut).
 */
function hug(shadow: string, start: number, end: number, floor: number): [number, number] {
  let s = start;
  let e = end;
  const pairs: Record<string, string> = { '(': ')', '[': ']' };
  if (s > floor && pairs[shadow[s - 1]!] !== undefined && shadow[e] === pairs[shadow[s - 1]!]) {
    s -= 1;
    e += 1;
  }
  while (s > floor && (shadow[s - 1] === '#' || shadow[s - 1] === '№')) s -= 1;
  const label = HUGGING_LABEL.exec(shadow.slice(floor, s));
  if (label) s -= label[0].length;
  return [s, e];
}

/**
 * Every match of `re` on the shadow (that `when` accepts) spliced out of BOTH
 * strings at the same indices.
 */
function cut(text: Text, re: RegExp, when: (match: string) => boolean = () => true): Text {
  let out = '';
  let shadow = '';
  let last = 0;
  for (const m of text.shadow.matchAll(re)) {
    if (m[0].length === 0 || m.index < last || !when(m[0])) continue;
    const [s, e] = hug(text.shadow, m.index, m.index + m[0].length, last);
    out += `${text.out.slice(last, s)}${CUT}`;
    shadow += `${text.shadow.slice(last, s)}${CUT}`;
    last = e;
  }
  return { out: out + text.out.slice(last), shadow: shadow + text.shadow.slice(last) };
}

/**
 * Whole units as ONE edge-bounded alternation, longest first — so «MANIKEN-AL»
 * wins over a «MANIKEN» it contains. Null for none.
 */
function unitsRegex(patterns: Iterable<string>, edges: Edges = WORD_EDGES): RegExp | null {
  const list = [...new Set(patterns)].sort((a, b) => b.length - a.length);
  return list.length === 0 ? null : new RegExp(`${edges.before}(?:${list.join('|')})${edges.after}`, 'giu');
}

/** The first letter/digit run of a folded unit, lower-cased — what a name must carry WHOLE for the unit to stand in it. */
function firstRunOf(folded: string): string | null {
  return /[\p{L}\p{N}]+/u.exec(folded.toLowerCase())?.[0] ?? null;
}

const PHONE = /\+?\d(?:[\s\-+.()]*\d){6,}/gu;

/** One post's scrub, compiled once and run over every goods name. */
export type Scrubber = (name: string) => string;

/**
 * A goods name with every way to its client taken out (F4 a). Matching runs on
 * a folded SHADOW (NFKC, Cyrillic look-alikes as Latin, case-insensitive,
 * Unicode word edges) and every removal is spliced out of the name itself:
 *   1. TOKENS that are a way to a person or a card (`LINK_TOKEN`) — first, so
 *      no code shape can carve a uuid into debris;
 *   2. the MARKINGS (≥ 3), each ONE unit and never split into words, or «Ali
 *      kurtka» would eat «kurtka» from every name — and BEFORE any piece of
 *      them can be cut: a marking that starts with a code or a person
 *      («GS500 MANIKEN», «Ali Bobur») would otherwise lose that piece first,
 *      stop matching, and post its tail, which ⌘K finds the lot by;
 *   3. the card's PEOPLE, word by word (≥ 3 code points, whole words only —
 *      «Ali» must not eat «Natalia» or «Alyuminiy»);
 *   4. whole CODES: the card's own (any length), the book's codes the names
 *      carry (≥ 3), each with a seam, the lot suffix and whatever is glued to
 *      it by `-`, `_` or `.`; an all-digit one never as a quantity;
 *   5. the system's SHAPES (crate, box, receipt, pickup, deal), then the
 *      client-code prefix or its Cyrillic spelling followed by a digit — so
 *      a code minted under today's prefix goes even when the book was not asked;
 *   6. a phone in any spelling (≥ 7 digits with spaces, dashes, `+`, dots or
 *      brackets between them);
 *   7. remnants: empty brackets, separators a cut left alone, whitespace, edge
 *      punctuation — and only what a cut left: a range the seller typed stays.
 * Codes and shapes take the CODE edge (CJK is not part of their word); people
 * and markings the plain one.
 * An empty result drops the name.
 *
 * Compiled ONCE per post: a thousand-line invoice against three thousand
 * markings was half a minute of regex construction, one per marking per name.
 * A name is tried only against the markings whose first run it carries whole
 * (the edges make that exact, `markingCandidates`).
 *
 * STATED, not caught: a two-character code of another client («A4» reads like
 * a paper size), a code with no digit, a CJK marking or name glued to other
 * letters with no edge, a code glued to a Latin or Cyrillic word with no
 * separator («kurtkaGS777» — the edge that keeps «GSM modul» a word), an
 * all-digit code a unit follows («444 L»), and a deal code spelled with a
 * bare space («B 000099»).
 */
export function makeScrubber(ctx: ScrubContext): Scrubber {
  const words = new Set<string>();
  for (const f of ctx.forbidden) {
    for (const part of nfkc(f).split(/[\s,;:/()+-]+/u)) {
      if ([...part].length >= 3) words.add(escapeRegExp(fold(part)));
    }
  }
  const wordsRe = unitsRegex(words);

  const codes: string[] = [];
  const codeUnit = (code: string) => `${asCode(codePattern(code), code)}${LOT}${GLUED}`;
  for (const code of ctx.ownCodes) {
    if (code.trim() !== '') codes.push(codeUnit(code.trim()));
  }
  for (const code of ctx.knownCodes) {
    if ([...code.trim()].length >= 3) codes.push(codeUnit(code.trim()));
  }
  const codesRe = unitsRegex(codes, CODE_EDGES);

  // The markings grouped by their FIRST run: a name is tried only against
  // the groups whose run it carries whole (the edges make that exact, see
  // `markingCandidates`), and each group is ONE alternation compiled the
  // first time a name needs it — a `\p{L}` edge costs ~0.4 ms to compile, and
  // a regex per marking per name was half a minute on a thousand-line invoice.
  const markingsByRun = new Map<string, string[]>();
  const runless: string[] = [];
  for (const marking of ctx.markings) {
    const m = fold(nfkc(marking)).trim();
    if ([...m].length < 3) continue;
    const pattern = asCode(m.split(/\s+/u).map(escapeRegExp).join('\\s+'), m);
    const run = firstRunOf(m);
    if (run === null) runless.push(pattern);
    else markingsByRun.set(run, [...(markingsByRun.get(run) ?? []), pattern]);
  }
  const runlessRe = unitsRegex(runless);
  const groupRe = new Map<string, RegExp | null>();
  const markingsFor = (run: string): RegExp | null => {
    if (!groupRe.has(run)) groupRe.set(run, unitsRegex(markingsByRun.get(run) ?? []));
    return groupRe.get(run) ?? null;
  };

  const shapes = SYSTEM_SHAPES.map((shape) => new RegExp(`${CODE_EDGES.before}${shape}${CODE_EDGES.after}`, 'giu'));
  const prefix = nfkc(ctx.codePrefix).trim().toUpperCase();
  let prefixRe: RegExp | null = null;
  if (prefix) {
    const cyrillic = [...prefix].map((ch) => CYRILLIC_SPELLING[ch] ?? ch).join('');
    const spellings = [...new Set([fold(prefix), fold(cyrillic)])].map(escapeRegExp).join('|');
    // The tail runs on through a glued marking («GS500MANIKEN-AL») but never
    // into CJK — «GS777男士夹克» keeps its goods. Not the ASCII alphabet: the
    // fold maps eleven look-alikes, so «GS555куртка» would stop at «у», fail
    // the edge and post the code.
    prefixRe = new RegExp(
      `${CODE_EDGES.before}(?:${spellings})${SEAM}\\d(?:${CODE_ALNUM}|-)*${CODE_EDGES.after}`,
      'giu',
    );
  }

  return (name: string): string => {
    const normal = nfkc(name).replace(/\u0000/gu, ' ');
    let t: Text = { out: normal, shadow: fold(normal) };

    t = cut(t, /\S+/gu, (token) => LINK_TOKEN.some((re) => re.test(token)));
    // The markings while every piece of them still stands (step 2).
    const runs = new Set([...t.shadow.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]));
    for (const run of runs) {
      if (!markingsByRun.has(run)) continue;
      const re = markingsFor(run);
      if (re) t = cut(t, re);
    }
    if (runlessRe) t = cut(t, runlessRe);
    if (wordsRe) t = cut(t, wordsRe);
    if (codesRe) t = cut(t, codesRe);

    for (const re of shapes) t = cut(t, re);
    if (prefixRe) t = cut(t, prefixRe);

    t = cut(t, PHONE);

    // What framed a removed unit and now frames nothing: empty brackets, a
    // separator a cut left standing alone («YW-045 / YW26-000123» → «YW-045»).
    // Only at a cut — «Kabel 10 - 20 m» and «Stol / stul» are the seller's.
    return t.out
      .replace(/[(\[][\s\u0000]*[)\]]/gu, ' ')
      .replace(ORPHAN_AT_CUT, '$1 ')
      .replace(/\u0000/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .replace(/^[\s,;:·\-–—/|]+|[\s,;:·\-–—/|]+$/gu, '')
      .trim();
  };
}

/** One name — `makeScrubber` for a single use (the tests, and any one-off caller). */
export function scrubIdentity(name: string, ctx: ScrubContext): string {
  return makeScrubber(ctx)(name);
}

/**
 * The client codes these names MIGHT carry — what the builder asks the book
 * about (`clients_code_unique`). Folded and upper-cased, because a code is
 * upper-case by CHECK: every ASCII letter/digit run of 2-10 holding a digit,
 * and every two neighbours joined across one seam (`GS 555` → `GS555`). A lot
 * suffix needs no rule of its own — `444-A` is the run `444`.
 */
export function codeCandidates(names: readonly string[]): string[] {
  const out = new Set<string>();
  const candidate = (s: string) => s.length >= 2 && s.length <= 10 && /\d/.test(s);
  for (const name of names) {
    const shadow = fold(nfkc(name)).toUpperCase();
    const runs = [...shadow.matchAll(/[A-Z0-9]+/g)];
    runs.forEach((run, i) => {
      if (candidate(run[0])) out.add(run[0]);
      const next = runs[i + 1];
      const end = run.index + run[0].length;
      if (next && next.index === end + 1 && /^[\s\-_.#№]$/u.test(shadow[end]!)) {
        if (candidate(run[0] + next[0])) out.add(run[0] + next[0]);
      }
    });
  }
  return [...out];
}

/** A text's letter/digit runs as the scrub's edges cut them: NFKC, folded, lower-case. */
function runsOf(text: string): string[] {
  return [...fold(nfkc(text)).toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]);
}

/**
 * Which of the company's markings these names MIGHT carry — markings + names,
 * never markings × names. A marking the scrub can remove stands between word
 * edges, so its FIRST letter/digit run is a whole run of the name; a marking
 * with no run at all is looked for as plain text. A superset by construction:
 * the scrub's own edge-bounded match still decides.
 */
export function markingCandidates(names: readonly string[], markings: readonly string[]): string[] {
  const runs = new Set(names.flatMap(runsOf));
  const text = fold(nfkc(names.join('\n'))).toLowerCase();
  const out = new Set<string>();
  for (const marking of markings) {
    const m = marking.trim();
    if ([...m].length < 3) continue;
    const first = runsOf(m)[0];
    if (first !== undefined ? runs.has(first) : text.includes(fold(nfkc(m)).toLowerCase())) out.add(m);
  }
  return [...out];
}

const SECTION_TITLES: Record<ChannelSection | 'none', string> = {
  rastamojka: `🛃 ${b('RASTAMOJKA')}`,
  yolkira: `🚚 ${b('YO‘LKIRA')}`,
  podklyuch: `🔑 ${b('PODKLYUCH')}`,
  none: `🧮 ${b('HISOB')}`,
};

/** The business risk said once: a channel figure is a guide, not the reader's quote. */
export const POST_FOOTER = 'ℹ️ Mijozingiz uchun o‘zingiz hisoblatib oling — boshqa yuk boshqacha chiqadi.';

function dayDots(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : day;
}

function perUnitText(p: { value: number; unit: 'kg' | 'm3' }): string {
  const places = p.unit === 'kg' && p.value < 1 ? 3 : 2;
  return `$${groupDigits(p.value, places)}/${p.unit === 'kg' ? 'kg' : 'm³'}`;
}

function amountText(view: ChannelPostView): string {
  if (view.currency === 'USD') return usd(view.amount);
  return `${groupDigits(view.amount)} ${view.currency}`;
}

/**
 * The post, as Telegram HTML — built ONLY from `h()` over the view's values.
 * `mark` null = the price stands; otherwise its line goes first and the price
 * line is struck through.
 */
export function channelPostHtml(view: ChannelPostView, mark: PostMark | null): string {
  const lines: string[] = [];
  if (mark) lines.push(markLine(mark));
  const title = SECTION_TITLES[view.section ?? 'none'];
  if (view.kind === 'answer') lines.push(`${title} · ✍️ qo‘lda berilgan`);
  else lines.push(view.quoteNo !== null ? `${title} · V${view.quoteNo}` : title);
  if (view.isCorrection) {
    lines.push(
      view.replacesQuoteNo !== null
        ? `🔄 Avvalgi narx (V${view.replacesQuoteNo}) o‘rniga`
        : '🔄 Avvalgi narx o‘rniga',
    );
  }
  const price = `💵 ${b(h(amountText(view)))}${view.perUnit ? ` · ${h(perUnitText(view.perUnit))}` : ''}`;
  lines.push(mark ? `<s>${price}</s>` : price);
  if (view.goods.length > 0) {
    const names = view.goods.map((g) => h(clipText(g, 40))).join(', ');
    lines.push(`📦 ${names}${view.goodsMore > 0 ? ` (+${view.goodsMore})` : ''}`);
  }
  const measures = [
    view.weightKg !== null ? `${groupDigits(view.weightKg)} kg` : null,
    view.volumeM3 !== null ? `${groupDigits(view.volumeM3)} m³` : null,
  ].filter((x): x is string => x !== null);
  if (measures.length > 0) lines.push(`⚖️ ${h(measures.join(' · '))}`);
  const people = `👤 Sotuvchi: ${h(clipText(view.sellerName, 60))}${
    view.vedName ? ` · 🧮 VED: ${h(clipText(view.vedName, 60))}` : ''
  }`;
  lines.push(people);
  lines.push(
    `📅 ${h(dayDots(view.day))}${view.validUntilDay ? ` · ${h(dayDots(view.validUntilDay))} gacha amal qiladi` : ''}`,
  );
  lines.push(POST_FOOTER);
  return lines.join('\n');
}

/** Every mark a stored view may ever be rendered with — the fit is judged against the longest. */
const ALL_MARKS: (PostMark | null)[] = [
  null,
  ...(Object.keys(MARK_LINES) as ChildState[]).flatMap((state) => [
    { state, childPosted: true },
    { state, childPosted: false },
  ]),
];

/**
 * The view with goods names dropped from the END (raising `goodsMore`) until
 * the post fits the caption ceiling WITH its longest possible mark — so the
 * correction edit can never be refused for length. Throws only if it still
 * cannot fit with no names at all, which the layout makes impossible (pinned
 * by the worst-case test).
 */
export function fitGoods(view: ChannelPostView): ChannelPostView {
  const longest = (v: ChannelPostView) => Math.max(...ALL_MARKS.map((m) => visibleLength(channelPostHtml(v, m))));
  let out: ChannelPostView = { ...view, goods: [...view.goods] };
  while (longest(out) > CHANNEL_POST_MAX && out.goods.length > 0) {
    out = { ...out, goods: out.goods.slice(0, -1), goodsMore: out.goodsMore + 1 };
  }
  if (longest(out) > CHANNEL_POST_MAX) throw new Error('price channel post cannot fit');
  return out;
}
