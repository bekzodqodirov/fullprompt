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
 * Round 2 adds 'receipt' and 'batch' here, a door arm and an audience arm
 * each, and one CHECK widening — nothing else.
 */

export const THREAD_KINDS = ['lead', 'deal', 'client', 'calc'] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

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

/** `${kind}:${id}` — the key a set of admitted threads is held under. */
export function threadKey(ref: ThreadRef): string {
  return `${ref.kind}:${ref.id.toLowerCase()}`;
}
