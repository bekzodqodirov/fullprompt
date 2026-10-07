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
 * A goods name with the card's identity taken out (F4 a), step by step:
 *   1. the words of every forbidden string (the client's code, name, phones;
 *      the lead's name, company, phone), split on whitespace and `,;:/()+-`,
 *      kept at ≥ 3 code points;
 *   2. each removed as a WHOLE word, Unicode-aware — never JS `\b` (ASCII-only:
 *      «Алишер» would never match, round 37) and never a bare substring («Ali»
 *      must not eat «Natalia» or «Alyuminiy»);
 *   3. every token starting with the client-code prefix and a digit — a
 *      person's sibling codes (#407), another client's code and an unclaimed
 *      marking are not in the card's list at all;
 *   4. every token with `@`, `t.me/` or `://` (a handle or a link names a person);
 *   5. every run of ≥ 7 digits with spaces, dashes, `+`, dots or brackets
 *      between them (a phone in any spelling);
 *   6. whitespace collapsed and punctuation-only remnants trimmed.
 * An empty result drops the name.
 */
export function scrubIdentity(name: string, forbidden: string[], codePrefix: string): string {
  const words = new Set<string>();
  for (const f of forbidden) {
    for (const part of f.split(/[\s,;:/()+-]+/u)) {
      if ([...part].length >= 3) words.add(part.toLocaleLowerCase());
    }
  }
  let out = name;
  for (const word of words) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'giu'), ' ');
  }
  const prefix = codePrefix.trim().toLocaleLowerCase();
  out = out
    .split(/\s+/u)
    .filter((token) => {
      if (token === '') return false;
      const lower = token.toLocaleLowerCase();
      if (prefix && lower.startsWith(prefix) && /\p{N}/u.test([...lower.slice(prefix.length)][0] ?? '')) return false;
      if (lower.includes('@') || lower.includes('t.me/') || lower.includes('://')) return false;
      return true;
    })
    .join(' ');
  out = out.replace(/\+?\d(?:[\s\-+.()]*\d){6,}/gu, ' ');
  out = out
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^[\s,;:·\-–—]+|[\s,;:·\-–—]+$/gu, '')
    .trim();
  return out;
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
