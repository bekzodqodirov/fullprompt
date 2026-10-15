/**
 * The vocabulary of a staff THREAD (the owner's E answers, 2026-10-07) — the
 * one home of what both halves need: the web card and its writer (wms) and
 * the Telegram reply door, the mutes and the routes (platform). It lives in
 * PLATFORM because platform must never import wms, and the bot is the half
 * that has to read a ping's `payload.thread` back.
 *
 * A thread exists only on a work card (E1 a — no DMs, no rooms):
 *   - `{ kind: 'lead'|'deal'|'client', id }` — that card's UNTAGGED notes;
 *   - `{ kind: 'calc', id: requestId }` — the notes tagged with that
 *     calculation (`crm_activities.calc_request_id`, 0127), wherever the
 *     request's card was when each was written.
 *   - `{ kind: 'receipt'|'batch', id }` — a prixod's or a truck's untagged
 *     notes (round 2, 0129): the CARGO threads, read by the office and the
 *     staff of the warehouse where the cargo stands now (E6 c, E7 b, Q4 a).
 *
 * Round 2 was announced here as «a door arm and an audience arm each, and
 * one CHECK widening — nothing else», and that was understated: every branch
 * over a thread kind was an `if/else` chain whose last arm was another kind,
 * so the widened list compiled and filed a prixod under the calc door, the
 * clients table or «lid». Every such branch is now an exhaustive `switch`
 * with a `never` default (or a `Record` over the union, `idsByKind`), so the
 * next kind is a compile error — fenced by tests/unit/cargo-thread-wire.
 */

export const THREAD_KINDS = ['lead', 'deal', 'client', 'calc', 'receipt', 'batch'] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

/** A thread that IS a card's untagged notes — every kind but the calculation's. */
export type CardKind = Exclude<ThreadKind, 'calc'>;

/** The two cargo cards (round 2): a prixod and a truck. */
export const CARGO_KINDS = ['receipt', 'batch'] as const;
export type CargoKind = (typeof CARGO_KINDS)[number];

/** Is this kind a cargo card's — the one test a branch on «cargo or not» asks, never a literal. */
export function isCargoKind(kind: string): kind is CargoKind {
  return (CARGO_KINDS as readonly string[]).includes(kind);
}

export interface ThreadRef {
  kind: ThreadKind;
  id: string;
}

/**
 * A message's ceiling. Telegram caps one message at 4096 characters, and a
 * reply typed there must fit the same box the web refuses past — the web box
 * carries `maxLength` and the writer refuses `too_long`.
 */
export const THREAD_TEXT_MAX = 4000;

/**
 * The DOCK list's window — and nothing else. The Telegram reply door has no
 * age window on purpose: nothing prunes `notifications`, the door is re-asked
 * at reply time, and an «expired» refusal would only make a colleague retype
 * on the card.
 */
export const THREAD_WINDOW_DAYS = 60;

/**
 * The three pings a thread sends — what a swipe-reply in Telegram may land
 * back on, and what the «Ichki yozishmalar» mute group holds (E8 a). The card
 * thread's note, the @mention, and the calculation's question.
 */
export const THREAD_PING_TYPES = ['InternalNote', 'MentionedInNote', 'CalcThread'] as const;
export type ThreadPingType = (typeof THREAD_PING_TYPES)[number];

/**
 * A task's copies a reply turns into a question to its giver (E4 a), or —
 * for the VED's bound «Hisoblash: …» task — into a question to the seller
 * under that calculation (E3 a). `TaskQuestion` is the author's copy: a reply
 * to it is the ANSWER.
 */
export const TASK_REPLY_TYPES = ['TaskAssigned', 'TaskReminder', 'TaskAnswer', 'TaskQuestion'] as const;

/**
 * The STRICT uuid shape (`calc/card-door.ts`'s): every id below is cast
 * `::uuid`, and the loose «36 hex and dashes» admits strings postgres refuses
 * with 22P02 — a forged or truncated id must be «no such thread», never an
 * error page (#514).
 */
export const THREAD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The routes' body validator — a ref from a browser is a claim until it is checked. */
export function isThreadRef(value: unknown): value is ThreadRef {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { kind?: unknown; id?: unknown };
  return (
    typeof v.kind === 'string' &&
    (THREAD_KINDS as readonly string[]).includes(v.kind) &&
    typeof v.id === 'string' &&
    THREAD_UUID.test(v.id)
  );
}

/**
 * A read mark as the browser posts it: the thread, and the moment of the
 * newest message the screen DREW (`markThreadRead`'s «as of»). An instant
 * that does not parse is no mark at all.
 */
export type ThreadReadMark = ThreadRef & { asOf: string };

/**
 * The instant's ONE spelling — UTC, to the MICROSECOND, as postgres stores it
 * (`thread.ts`'s `instantSql`). A JS `Date` holds milliseconds, and a mark
 * truncated to the millisecond is BEFORE the very note it was taken from, so
 * that note stays ● for ever; the instant therefore travels as this string
 * and is never parsed into a Date on the way. Strict, because it is cast
 * `::timestamptz` and a loose one is a 22007, not «no mark».
 */
export const THREAD_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export function isThreadReadMark(value: unknown): value is ThreadReadMark {
  if (!isThreadRef(value)) return false;
  const asOf = (value as { asOf?: unknown }).asOf;
  return typeof asOf === 'string' && THREAD_INSTANT.test(asOf);
}

/**
 * A ping's `payload.thread`, validated — or null. Written by the announce
 * (`extra.thread`), read by the reply door and the dock; a payload written
 * before 0127 has none, and a malformed one is nobody's thread.
 */
export function threadOfPayload(payload: unknown): (ThreadRef & { activityId: string }) | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const thread = (payload as { thread?: unknown }).thread;
  if (!isThreadRef(thread)) return null;
  const activityId = (thread as { activityId?: unknown }).activityId;
  if (typeof activityId !== 'string' || !THREAD_UUID.test(activityId)) return null;
  return { kind: thread.kind, id: thread.id.toLowerCase(), activityId: activityId.toLowerCase() };
}

/**
 * The ids of a list of refs, grouped by kind — strict-uuid filtered,
 * lower-cased, deduplicated. A `Record` over the union, seeded from
 * `THREAD_KINDS`, so a new kind is a key here before anybody asks for it, and
 * no caller writes its own `.kind === '…'` filter (cargo-thread-wire K1).
 */
export function idsByKind(refs: readonly ThreadRef[]): Record<ThreadKind, string[]> {
  const sets = Object.fromEntries(THREAD_KINDS.map((kind) => [kind, new Set<string>()])) as Record<
    ThreadKind,
    Set<string>
  >;
  for (const ref of refs) {
    if (!THREAD_UUID.test(ref.id)) continue;
    sets[ref.kind]?.add(ref.id.toLowerCase());
  }
  return Object.fromEntries(THREAD_KINDS.map((kind) => [kind, [...sets[kind]]])) as Record<ThreadKind, string[]>;
}

/** `${kind}:${id}` — the key a set of admitted threads is held under. */
export function threadKey(ref: ThreadRef): string {
  return `${ref.kind}:${ref.id.toLowerCase()}`;
}
