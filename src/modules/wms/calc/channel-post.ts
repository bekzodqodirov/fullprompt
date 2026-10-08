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
export function nfkc(s: string): string {
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
/** What a person puts between a code's letters and its digits: `GS 555`, `GS-555`, `GS#555`. */
const SEAM = '[\\s\\-_.#№]?';
/** The search's lot form, `GS777-A`. */
const LOT = '(?:\\s?-\\s?\\p{L}{1,2})?';

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
 * KEPT on purpose: the batch `YW-045`. A truck carries many clients, its
 * contents sit behind `BATCH_READERS`, and `{PREFIX}-{NNN}` cannot be told
 * from «LED-100» — scrubbing it would eat real goods names.
 */
const SYSTEM_SHAPES: readonly string[] = [
  /* crate   */ 'CR-[A-Za-z0-9]*\\d{2}-\\d{5,}',
  /* box     */ '[A-Za-z][A-Za-z0-9]*\\d{2}-\\d{6,}',
  /* receipt */ '[A-Za-z0-9]+\\s?-\\s?IN\\s?-\\s?\\d{6}\\s?-\\s?\\d+',
  /* pickup  */ 'ZR-\\d{5,}',
  /* deal    */ '[BБ](?:\\s?[-‐‑‒–—_]\\s?\\d{3,}|\\s?\\d{6,})',
];

/** The name and its folded shadow — the same length, cut at the same indices. */
interface Text {
  out: string;
  shadow: string;
}

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
    out += `${text.out.slice(last, s)} `;
    shadow += `${text.shadow.slice(last, s)} `;
    last = e;
  }
  return { out: out + text.out.slice(last), shadow: shadow + text.shadow.slice(last) };
}

/** Whole units, longest first — so «MANIKEN-AL» goes before a «MANIKEN» it contains. */
function cutUnits(text: Text, patterns: readonly string[]): Text {
  let t = text;
  for (const p of [...new Set(patterns)].sort((a, b) => b.length - a.length)) {
    t = cut(t, new RegExp(`${EDGE_BEFORE}(?:${p})${EDGE_AFTER}`, 'giu'));
  }
  return t;
}

/**
 * A goods name with every way to its client taken out (F4 a). Matching runs on
 * a folded SHADOW (NFKC, Cyrillic look-alikes as Latin, case-insensitive,
 * Unicode word edges) and every removal is spliced out of the name itself:
 *   1. TOKENS that are a way to a person or a card (`LINK_TOKEN`) — first, so
 *      no code shape can carve a uuid into debris;
 *   2. the card's PEOPLE, word by word (≥ 3 code points, whole words only —
 *      «Ali» must not eat «Natalia» or «Alyuminiy»);
 *   3. whole CODES: the card's own (any length), the book's codes the names
 *      carry (≥ 3), each with a seam and the lot suffix; the markings (≥ 3),
 *      each ONE unit and never split into words, or «Ali kurtka» would eat
 *      «kurtka» from every name;
 *   4. the system's SHAPES (crate, box, receipt, pickup, deal), then the
 *      client-code prefix or its Cyrillic spelling followed by a digit — so
 *      a code minted under today's prefix goes even when the book was not asked;
 *   5. a phone in any spelling (≥ 7 digits with spaces, dashes, `+`, dots or
 *      brackets between them);
 *   6. remnants: empty brackets, orphan separators, whitespace, edge punctuation.
 * An empty result drops the name.
 *
 * STATED, not caught: a two-character code of another client («A4» reads like
 * a paper size), a code with no digit, and a CJK marking glued to other
 * letters with no edge.
 */
export function scrubIdentity(name: string, ctx: ScrubContext): string {
  const normal = nfkc(name);
  let t: Text = { out: normal, shadow: fold(normal) };

  t = cut(t, /\S+/gu, (token) => LINK_TOKEN.some((re) => re.test(token)));

  const words = new Set<string>();
  for (const f of ctx.forbidden) {
    for (const part of nfkc(f).split(/[\s,;:/()+-]+/u)) {
      if ([...part].length >= 3) words.add(escapeRegExp(fold(part)));
    }
  }
  t = cutUnits(t, [...words]);

  const units: string[] = [];
  for (const code of ctx.ownCodes) {
    if (code.trim() !== '') units.push(`${codePattern(code.trim())}${LOT}`);
  }
  for (const code of ctx.knownCodes) {
    if ([...code.trim()].length >= 3) units.push(`${codePattern(code.trim())}${LOT}`);
  }
  t = cutUnits(t, units);
  const markings: string[] = [];
  for (const marking of ctx.markings) {
    const m = fold(nfkc(marking)).trim();
    if ([...m].length >= 3) markings.push(m.split(/\s+/u).map(escapeRegExp).join('\\s+'));
  }
  t = cutUnits(t, markings);

  for (const shape of SYSTEM_SHAPES) {
    t = cut(t, new RegExp(`${EDGE_BEFORE}${shape}${EDGE_AFTER}`, 'giu'));
  }
  const prefix = nfkc(ctx.codePrefix).trim().toUpperCase();
  if (prefix) {
    const cyrillic = [...prefix].map((ch) => CYRILLIC_SPELLING[ch] ?? ch).join('');
    const spellings = [...new Set([fold(prefix), fold(cyrillic)])].map(escapeRegExp).join('|');
    t = cut(t, new RegExp(`${EDGE_BEFORE}(?:${spellings})${SEAM}\\d[\\p{L}\\p{N}-]*`, 'giu'));
  }

  t = cut(t, /\+?\d(?:[\s\-+.()]*\d){6,}/gu);

  // What framed a removed unit and now frames nothing: empty brackets, a
  // separator standing alone («YW-045 / YW26-000123» → «YW-045»).
  return t.out
    .replace(/[(\[]\s*[)\]]/gu, ' ')
    .replace(/(^|\s)[-–—_#№:/|]+(?=\s|$)/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^[\s,;:·\-–—/|]+|[\s,;:·\-–—/|]+$/gu, '')
    .trim();
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
