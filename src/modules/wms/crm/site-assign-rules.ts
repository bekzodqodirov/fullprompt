import type { MessageRow } from './telegram-import';
import { bridgeState, isClientVerdict, type BridgeState, type LiveVerdict } from './telegram-live';

/**
 * Saytdan so'rov → eng bo'sh menejer (round 113) — the decisions, with no
 * database and no network, so every one of them is testable as a function.
 *
 * The owner's words: «saytdan kelgan zaproslar hodimlar sotuv managerlari
 * orasida taqsimlansin va hodimlarda belgilaylik qanday zaprosga kim javob
 * beradi». The website asks «who in this team is least busy?» the moment its
 * questionnaire is finished, we answer with that person's Telegram username,
 * and the visitor writes to them carrying a one-off TAG that lets the listener
 * land the conversation as a lead.
 *
 * Everything here has exactly ONE home because it has several readers: the
 * tag shape is read by the route, the listener and a test that compares it to
 * the migration's CHECK; the load and the ranking are read by the route AND by
 * the panel that has to explain the route's choice (#513 — two copies of «who
 * is least busy» are two answers the day they drift).
 */

/** The website's three streams, as the site sends them. */
export const LEAD_TEAMS = ['cargo', 'buying', 'general'] as const;
export type LeadTeam = (typeof LEAD_TEAMS)[number];

/**
 * An unknown team is `general`, never a refusal: the site is another team's
 * code, and a stream it invents tomorrow must still reach a human today.
 */
export function readTeam(raw: string | null | undefined): LeadTeam {
  const value = (raw ?? '').trim().toLowerCase();
  return (LEAD_TEAMS as readonly string[]).includes(value) ? (value as LeadTeam) : 'general';
}

/**
 * The tag's one shape. `lead_assignments_tag_check` says the same thing in
 * the database and `site-assign-rules.test.ts` reads the migration to hold the
 * two together — three definitions (route, listener, CHECK) is how a four-
 * character tag passes the route and dies on the INSERT as a 500.
 */
export const LEAD_TAG_RE = /^GSR-[A-Z0-9]{5,16}$/;
const TAG_IN_TEXT = /(?:^|[^A-Za-z0-9-])(GSR-[A-Za-z0-9]{5,16})(?![A-Za-z0-9])/i;

/** A tag from the query string, or null. Upper-cased: the site mints capitals. */
export function readTag(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().toUpperCase();
  return LEAD_TAG_RE.test(value) ? value : null;
}

/**
 * The tag inside a message the visitor typed (or the site pre-filled). Case
 * is forgiven — a phone keyboard capitalises what it likes — and the match is
 * bounded on both sides so `XGSR-…` or a longer token is not half-read.
 */
export function findLeadTag(text: string | null | undefined): string | null {
  const hit = TAG_IN_TEXT.exec(text ?? '');
  return hit ? readTag(hit[1]) : null;
}

/**
 * What the website says about the visitor, cleaned before it is stored.
 *
 * All of it lands on a staff card as the SYSTEM's words («📣 sayt · cargo ·
 * yuk · /narxlar/»), and the door is public — so each value is held to a shape
 * that cannot carry a sentence: a lowercase slug, a site path, a known
 * language. Anything else is dropped, never refused (the visitor still gets a
 * manager; the card just says less).
 */
export const OFFER_LANGS = ['uz', 'ru', 'en', 'zh', 'zh-CN'] as const;

export function readOfferInput(params: URLSearchParams): {
  team: LeadTeam;
  tag: string | null;
  topic: string | null;
  page: string | null;
  lang: string | null;
} {
  const topic = (params.get('tag') ?? '').trim().toLowerCase();
  const page = (params.get('page') ?? '').trim();
  const lang = (params.get('lang') ?? '').trim();
  return {
    team: readTeam(params.get('team')),
    tag: readTag(params.get('lead')),
    topic: /^[a-z0-9][a-z0-9_-]{0,39}$/.test(topic) ? topic : null,
    page: /^\/[A-Za-z0-9/_.~%-]{0,160}$/.test(page) ? page : null,
    lang: (OFFER_LANGS as readonly string[]).includes(lang) ? lang : null,
  };
}

/** Telegram's own rule for a public username: 5-32, a letter first. */
export const TG_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

/**
 * A username as a person types it: `@ali_gsr`, `t.me/ali_gsr`,
 * `https://t.me/ali_gsr` all mean one handle. Empty = «none» (null); anything
 * that is not a valid handle is refused rather than stored, because this value
 * is handed to strangers as the place to write to.
 */
export function normalizeUsername(
  raw: string | null | undefined,
): { ok: true; value: string | null } | { ok: false } {
  let value = (raw ?? '').trim();
  if (!value) return { ok: true, value: null };
  value = value.replace(/^https?:\/\//i, '').replace(/^(?:www\.)?t(?:elegram)?\.me\//i, '');
  value = value.replace(/^@/, '').replace(/\/+$/, '');
  return TG_USERNAME_RE.test(value) ? { ok: true, value } : { ok: false };
}

/**
 * The handle of a Telegram account as gramjs hands it over.
 *
 * `username` is only the PRIMARY one and is absent for an account whose
 * handles all live in `usernames[]` (collectible or several, each with an
 * `active` flag) — reading `username` alone would call that manager «no
 * username» while they have one.
 */
export function primaryUsername(user: {
  username?: string | null;
  usernames?: { username: string; active?: boolean }[] | null;
}): string | null {
  const own = (user.username ?? '').trim();
  if (own) return own;
  const active = (user.usernames ?? []).find((u) => u.active && u.username);
  return active?.username ?? null;
}

/**
 * How long a verified handle stays trusted without being re-read. The
 * listener re-reads it every 20 minutes and on every rename it hears, so an
 * hour of silence means the listener is not there to hear a rename — and a
 * released handle can be registered by a stranger, who would then receive our
 * visitors and the questionnaire.
 */
export const USERNAME_FRESH_MS = 60 * 60 * 1000;

/**
 * How long a visitor has to actually write before an offer that COULD have
 * been confirmed stops counting as work. The site calls us as its last button
 * is pressed, so a real visitor writes within a minute or two; one who never
 * writes must not keep a manager «busy» for the rest of the day.
 */
export const PENDING_OFFER_MS = 15 * 60 * 1000;

/** How long a tag stays good for landing a conversation. */
export const TAG_VALID_MS = 24 * 60 * 60 * 1000;

export type Ineligible = 'no_username' | 'username_stale';

export interface PersonTelegram {
  /** Typed on /admin/taqsimot — what somebody believes the handle is. */
  typedUsername: string | null;
  /** Read by the listener from the connected account — what Telegram says. */
  account: {
    status: string;
    lastSeenAt: Date | null;
    username: string | null;
    checkedAt: Date | null;
  } | null;
}

export type Reachable =
  | {
      ok: true;
      username: string;
      source: 'verified' | 'typed';
      /** Can the listener see the conversation this offer starts, right now? */
      capturable: boolean;
      bridge: BridgeState | null;
    }
  | { ok: false; reason: Ineligible; bridge: BridgeState | null };

/**
 * Where a visitor sent to this person should write, and whether we will see
 * it happen.
 *
 * The verified handle wins while it is fresh; the typed one is the owner's
 * addition for people with no connected Telegram («telegrami ulangan bolmasa
 * ham ularni usernamini kirgazadgan joy bolsin») — reachable, never captured.
 * «Can we see it» is `bridgeState` itself, imported and not restated: a
 * second definition of «connected» beside the screen's is #513's mistake.
 */
export function reachableAt(person: PersonTelegram, now: Date): Reachable {
  const bridge = person.account ? bridgeState(person.account, now) : null;
  const live = bridge === 'live';
  const verified = person.account?.username ?? null;
  const fresh =
    verified !== null &&
    person.account?.checkedAt != null &&
    now.getTime() - person.account.checkedAt.getTime() <= USERNAME_FRESH_MS;
  if (verified && fresh) {
    return { ok: true, username: verified, source: 'verified', capturable: live, bridge };
  }
  if (person.typedUsername) {
    // A typed handle may be the SAME account the listener holds (the manager
    // simply has no public username on it yet, or it was read too long ago)
    // or another one entirely — we cannot tell, so we do not promise to see it.
    return { ok: true, username: person.typedUsername, source: 'typed', capturable: false, bridge };
  }
  return { ok: false, reason: verified ? 'username_stale' : 'no_username', bridge };
}

export interface LoadRow {
  userId: string;
  name: string;
  /** Units of work handed today — see `loadUnitsSql` in site-assign.ts. */
  units: number;
  /** When they were last handed one, or null for «not yet today». */
  lastAt: Date | null;
}

/**
 * Least busy first. Ties go to whoever was handed work LONGEST ago, and
 * «never today» sorts first — round 83's NULLS FIRST, for the same reason: a
 * person nobody has given anything yet is the front of the queue, not an
 * arbitrary place in it. The id is the last word so two runs over the same
 * numbers can never disagree about the order.
 */
export function rankByLoad<T extends LoadRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.units !== b.units) return a.units - b.units;
    const at = a.lastAt?.getTime() ?? -Infinity;
    const bt = b.lastAt?.getTime() ?? -Infinity;
    if (at !== bt) return at - bt;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
}

/**
 * The rate limiter's key for an address.
 *
 * IPv6 by its /64: one subscriber owns the whole prefix, so an exact-address
 * limit on IPv6 limits nothing. No address at all (the request did not come
 * through our proxy) is one shared bucket, never «unlimited».
 */
export function ipKey(ip: string | null | undefined): string {
  const value = (ip ?? '').trim();
  if (!value) return 'unknown';
  if (!value.includes(':')) return value;
  const bare = value.replace(/^\[|\]$/g, '').split('%')[0]!;
  const [head, tail] = bare.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail ? tail.split(':') : [];
  const missing = tail !== undefined ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => (g || '0').toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/**
 * A token bucket per key, held in memory.
 *
 * In memory on purpose: the app is ONE process (round 74), and counting a
 * public, unauthenticated door in postgres would make every refused call cost
 * two queries on the pool every staff screen shares (#714's pool, ten
 * connections). Lost on restart, which is harmless — a limiter that forgets
 * lets a little more through for a minute, never less.
 */
export class TokenBuckets {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  take(key: string, now: number): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.prune(now);
      bucket = { tokens: this.capacity, at: now };
      this.buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.at) * this.refillPerMs);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Full buckets hold no information; dropping them bounds the map. */
  private prune(now: number) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + (now - bucket.at) * this.refillPerMs >= this.capacity) {
        this.buckets.delete(key);
      }
    }
    // Still full of live keys: a flood from many addresses. Forgetting the
    // oldest is the cheap answer and only ever errs towards letting through.
    while (this.buckets.size >= this.maxKeys) {
      const first = this.buckets.keys().next().value;
      if (first === undefined) break;
      this.buckets.delete(first);
    }
  }
}

export type SiteTagAction =
  /** A stranger's first words carrying our tag: land them (`landSiteTag`). */
  | { kind: 'land'; tag: string }
  /** A chat that already belongs to a card: confirm the offer, change nothing else. */
  | { kind: 'confirm'; tag: string; clientId: string | null; leadId: string | null };

/**
 * What a tag in this message is allowed to do, given what the chat already is.
 *
 * Asked AFTER `decideIncoming`, because the verdict already carries every
 * refusal that must win over a website tag and they need not be restated:
 * Saved Messages, a group, a bot — and above all an `exclude`, a person's
 * written «never» for this chat, which a stranger typing a tag must not undo.
 * Only the verdicts that mean «we do not know this person» — the tray's
 * question, the work account's new lead, a hidden number — may be turned into
 * a landing. A chat that already has an owner keeps it, and the tag only
 * confirms the offer so it counts as the work it was.
 *
 * Incoming and not forwarded: our own message quoting a tag, or a visitor's
 * FORWARD of somebody else's, is not that person arriving from the website.
 */
export function siteTagAction(
  verdict: LiveVerdict,
  row: Pick<MessageRow, 'direction' | 'body' | 'fwdFrom'>,
): SiteTagAction | null {
  if (row.direction !== 'in' || row.fwdFrom !== null) return null;
  const tag = findLeadTag(row.body);
  if (!tag) return null;
  if (verdict.store) {
    if ('openLead' in verdict) return { kind: 'land', tag };
    if ('leadId' in verdict) return { kind: 'confirm', tag, clientId: null, leadId: verdict.leadId };
    if (isClientVerdict(verdict)) {
      return { kind: 'confirm', tag, clientId: verdict.clientId, leadId: null };
    }
    return null;
  }
  if ('ask' in verdict) return { kind: 'land', tag };
  return verdict.reason === 'no_phone' || verdict.reason === 'not_a_client'
    ? { kind: 'land', tag }
    : null;
}

/**
 * Could the listener's in-memory client book simply be OLD?
 *
 * The miss refresh (`shouldRefreshOnMiss`) was keyed on `not_a_client`, and
 * since round 79 `decideIncoming` never returns that verdict — a stranger is
 * a tray question or, on a work number, a new lead. So the refresh had been
 * dead code: a client given a code this morning went on the tray until the
 * ten-minute reload. These two are the verdicts that mean «this number is in
 * no book we hold».
 */
export function suspectsStaleBook(verdict: LiveVerdict): boolean {
  if (verdict.store) return 'openLead' in verdict;
  return 'ask' in verdict || verdict.reason === 'not_a_client';
}
