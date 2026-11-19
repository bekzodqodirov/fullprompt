import type { NoteSend } from '../notes/plan';
import { CONNECT_PHASE } from '../telegram/staff-group-rules';

/**
 * The new-client card as the drain carries it (0151, the owner, 2026-11-19:
 * «code berganda shu adreslar va botga ssilka qoshilib berilsin telegramga
 * kelsin sotuvchilar shuni ozini pereslat qilishsin») — the shapes and the
 * two pure rules, kept apart from the drain so they are provable without one.
 *
 * ONE notification row is SEVERAL messages: the staff instruction first, then
 * the forwardable part (the ticked notes merged, their files, the footer). The
 * drain has no memory of which of those already went, so the row carries it:
 * `done` is how many of the card's steps Telegram has confirmed (step 0 is the
 * staff line, step i the plan's i-1), stamped in SQL after EACH one, and a
 * replay — after a 429, a 5xx, a dead drain's reclaim — starts at `done`,
 * never at the top. Without it the seller's chat, the very chat he forwards
 * from, would fill with a second copy of the customer's album.
 *
 * The plan is FROZEN on the row when it is queued (`steps`), so «pastdagi N ta
 * xabar» in the staff line is counted from the same steps that are sent, and
 * a replay resumes the plan it started rather than a re-read of notes the
 * owner may be editing that minute.
 */
export const NEW_CLIENT_CARD = 'NewClientCard';

export interface NoteCardCursor {
  done: number;
  /** The staff line's own message — the row's `payload.tg` (it carries the card's link). */
  head: number | null;
  /** The messages each confirmed step became, in order. */
  ids: number[];
  /** Steps whose answer never came (our deadline, a cut socket): maybe in the chat, NEVER sent again. */
  maybe: number[];
  /**
   * Steps whose OWN bytes could not be read on the row's LAST attempt (review
   * FR1-4): certainly not in the chat, stepped over so the rest of the card
   * still reaches the seller — and named in the row's `error`.
   */
  skipped: number[];
}

export interface NoteCard extends NoteCardCursor {
  steps: NoteSend[];
}

/** The card on a row, or null — a row of the wrong shape goes as its words alone. */
export function noteCardOf(payload: Record<string, unknown>): NoteCard | null {
  const card = payload.card as Partial<NoteCard> | undefined;
  if (!card || typeof card !== 'object' || !Array.isArray(card.steps)) return null;
  const done = Number.isInteger(card.done) && (card.done as number) >= 0 ? (card.done as number) : 0;
  const ids = Array.isArray(card.ids) ? card.ids.filter((id): id is number => Number.isInteger(id)) : [];
  const maybe = Array.isArray(card.maybe) ? card.maybe.filter((i): i is number => Number.isInteger(i)) : [];
  const skipped = Array.isArray(card.skipped) ? card.skipped.filter((i): i is number => Number.isInteger(i)) : [];
  const head = Number.isInteger(card.head) ? (card.head as number) : null;
  return { steps: card.steps as NoteSend[], done, head, ids, maybe, skipped };
}

/**
 * How long ONE Telegram call of a card step may take — the zametka sender's
 * own deadline (telegram/note-send.ts reads it from here), our object-store
 * read included since review FR1-2.
 */
export const CARD_CALL_DEADLINE_MS = 60_000;

/**
 * The most calls ONE step makes (telegram/note-send.ts): the send itself, an
 * album's stale-id resend from the bytes, and its documents retry — each
 * repair at most once (review ALB-2).
 */
export const CARD_STEP_MAX_CALLS = 3;

/**
 * A new-client card left in 'sending' is put back after this long, not after
 * the drain's ten minutes (review FR1-1): while it sits there its seller's
 * other rows are held back, so the hold is short.
 *
 * Measured from the card's own HEARTBEAT, never from the run's claim: the
 * drain moves `claimed_at` when it reaches the card and again after every
 * step (service.ts), so the longest a LIVE drain is silent on a card is one
 * step — at most `CARD_STEP_MAX_CALLS` calls of `CARD_CALL_DEADLINE_MS` each,
 * three minutes, plus a staff line's 20-second calls in the step before the
 * plan. Five minutes is that with two to spare; a shorter window would put a
 * card a live drain is still sending back in the queue for a second drain to
 * send again — the duplicate the cursor exists to prevent.
 */
export const CARD_RECLAIM_MINUTES = 5;

/**
 * The first word of a step's failure when OUR OWN bytes could not be read —
 * the object store said no (a missing key, a MinIO 5xx, a reset to it) before
 * or while the upload was streamed. Written by the zametka sender
 * (telegram/note-send.ts `stepFailure`), read here; a constant beside the
 * verdict, so the two can never spell it apart.
 */
export const SOURCE_UNREADABLE = 'source_unreadable';

/**
 * What one step's failure means for the row — the price channel's rule
 * (calc/channel-send.ts) for the same reason: a message that may already be
 * in the chat is never sent again by the machine.
 *
 *   - `pause`     — a 429, or the bot's token refused: the drain's own pause,
 *                   the row handed back with its cursor untouched;
 *   - `retry`     — Telegram answered «no» to THIS attempt (a 4xx, a 500/503),
 *                   or the connect itself failed (nothing left the machine),
 *                   or our own file could not be read (the multipart body
 *                   never completed, so Telegram cannot have made a message
 *                   of it): the drain counts an attempt and the next run
 *                   starts here — and when the bytes never come back, the
 *                   budget runs out and the row says which file it was;
 *   - `ambiguous` — our deadline, a reset socket, a 502/504: the message may
 *                   be in the chat. Marked `maybe`, stepped over, never
 *                   repeated — a duplicate forward to a customer is worse than
 *                   a seller who reads the log line and presses the card's
 *                   button for a fresh copy.
 */
export function cardStepVerdict(answer: {
  status: number;
  description: string;
  retryAfter: number | null;
  botDown?: boolean;
}): 'pause' | 'retry' | 'ambiguous' {
  if (answer.status === 429 || answer.retryAfter !== null) return 'pause';
  if (answer.botDown || answer.status === 401 || answer.status === 404) return 'pause';
  if (answer.status === 0) {
    if (answer.description === 'no_bot_token') return 'retry';
    // Asked BEFORE the connect-phase words: a reset to MinIO reads «ECONNRESET»
    // too, and that one is ours, not Telegram's (review P1-DLV-2).
    if (answer.description.startsWith(SOURCE_UNREADABLE)) return 'retry';
    return CONNECT_PHASE.test(answer.description) ? 'retry' : 'ambiguous';
  }
  if (answer.status === 502 || answer.status === 504) return 'ambiguous';
  return 'retry';
}
