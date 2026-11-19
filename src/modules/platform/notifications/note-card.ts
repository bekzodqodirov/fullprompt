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
  const head = Number.isInteger(card.head) ? (card.head as number) : null;
  return { steps: card.steps as NoteSend[], done, head, ids, maybe };
}

/**
 * What one step's failure means for the row — the price channel's rule
 * (calc/channel-send.ts) for the same reason: a message that may already be
 * in the chat is never sent again by the machine.
 *
 *   - `pause`     — a 429, or the bot's token refused: the drain's own pause,
 *                   the row handed back with its cursor untouched;
 *   - `retry`     — Telegram answered «no» to THIS attempt (a 4xx, a 500/503),
 *                   or the connect itself failed (nothing left the machine):
 *                   the drain counts an attempt and the next run starts here;
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
    return CONNECT_PHASE.test(answer.description) ? 'retry' : 'ambiguous';
  }
  if (answer.status === 502 || answer.status === 504) return 'ambiguous';
  return 'retry';
}
