import {
  classifyWithRules,
  isWorthKeeping,
  toMessageRow,
  type ChatRule,
  type ClientPhones,
  type DialogPeer,
  type MessageRow,
  type RawMessage,
} from './telegram-import';

/**
 * Live receiving — phase 3 of the client chat.
 *
 * Phase 1 read history once, from a session that was thrown away. This keeps a
 * connection open so a client's message is in the CRM within seconds of them
 * sending it. Everything that DECIDES lives here, away from anything that
 * talks to Telegram, for the same reason as phase 1: the interesting parts
 * have to be testable without an account, a phone or a network.
 *
 * The privacy rule does not change and is not weakened by being live: a
 * message is stored only when the sender is a client — by the automatic phone
 * match, or because somebody wrote down that this chat is theirs. A manager's
 * family writing to them at nine in the evening reaches this code, is refused,
 * and is not stored, counted by name or logged. It is the same
 * `classifyWithRules` the import uses, deliberately — one rule, one place, so
 * a change to who counts as a client cannot apply to one path and not the
 * other.
 */

/**
 * The client book, held in memory for the life of the connection.
 *
 * A listener runs for days, and the book changes underneath it: the whole
 * point of this company is that new clients arrive. Re-reading it per message
 * would be a query per message for data that changes a few times a day, and
 * never re-reading it means a client who was given a code this morning is a
 * stranger until somebody restarts the process.
 *
 * So: a periodic refresh, AND a forced refresh the first time a message from
 * an unknown number arrives after the last one. That second rule is what makes
 * "we just added them, why is nothing coming through" not a thing — the
 * refresh is triggered by exactly the event that suspects staleness, and is
 * rate-limited so an evening of family chat cannot turn into a query per
 * message.
 */
export interface BookState {
  clients: ClientPhones[];
  loadedAt: number;
  /** When a miss last forced a reload, so misses cannot become a query loop. */
  missRefreshedAt: number;
}

/** Periodic refresh. Ten minutes: new clients are typed in by hand, not by the second. */
export const BOOK_STALE_MS = 10 * 60 * 1000;
/** At most one miss-triggered refresh per minute, however many strangers write. */
export const BOOK_MISS_COOLDOWN_MS = 60 * 1000;

export function newBook(clients: ClientPhones[], now: number): BookState {
  return { clients, loadedAt: now, missRefreshedAt: 0 };
}

/** Is the book simply old? */
export function bookIsStale(book: BookState, now: number, staleMs = BOOK_STALE_MS): boolean {
  return now - book.loadedAt >= staleMs;
}

/**
 * A message from an unknown number arrived — is it worth re-reading the book
 * before deciding they are a stranger?
 */
export function shouldRefreshOnMiss(
  book: BookState,
  now: number,
  cooldownMs = BOOK_MISS_COOLDOWN_MS,
): boolean {
  // Nothing to gain from re-reading a book we loaded moments ago.
  if (now - book.loadedAt < cooldownMs) return false;
  return now - book.missRefreshedAt >= cooldownMs;
}

export type LiveVerdict =
  | { store: true; clientId: string; clientCode: string; row: MessageRow }
  /**
   * `not_a_client` and `no_phone` are the private ones and carry NOTHING about
   * who wrote — no id, no name, no number. The caller may count them; it may
   * not identify them.
   */
  | {
      store: false;
      reason:
        | 'not_private'
        | 'is_bot'
        | 'no_phone'
        | 'not_a_client'
        | 'excluded'
        | 'self'
        | 'empty';
    };

/**
 * One incoming message, decided.
 *
 * `empty` is separate from the privacy refusals: it is a client, and the
 * message is a service entry with no text and no media ("call ended", a pinned
 * marker). Worth nothing in a thread, and worth distinguishing in the counters
 * from a message we declined to read.
 */
export function decideIncoming(
  peer: DialogPeer,
  msg: RawMessage,
  clients: ClientPhones[],
  rules: Map<bigint, ChatRule> = new Map(),
): LiveVerdict {
  const verdict = classifyWithRules(peer, clients, rules);
  if (!verdict.keep) return { store: false, reason: verdict.reason };
  const row = toMessageRow(peer.id, msg);
  if (!isWorthKeeping(row)) return { store: false, reason: 'empty' };
  return { store: true, clientId: verdict.clientId, clientCode: verdict.clientCode, row };
}

/**
 * How far behind the bridge is, in seconds, or null when it has never run.
 *
 * A row in `tg_accounts` is a stored login, not a live connection — the
 * process can be stopped, crashed, or locked out by another copy of itself.
 * The screen has to be able to tell "connected" from "configured", so it asks
 * this rather than the presence of a row.
 */
export function secondsBehind(lastSeenAt: Date | null, now: Date): number | null {
  if (!lastSeenAt) return null;
  return Math.max(0, Math.floor((now.getTime() - lastSeenAt.getTime()) / 1000));
}

/** The heartbeat interval, and the window the screen calls "live". */
export const HEARTBEAT_MS = 30 * 1000;
/** Two missed beats plus slack: a tick late is not an outage. */
export const LIVE_WINDOW_S = 90;

export type BridgeState = 'live' | 'stale' | 'never' | 'stopped' | 'signed_out';

/**
 * What to tell the manager, in one word.
 *
 * `signed_out` and `stopped` come from the row and outrank the clock: if
 * Telegram ended the session, "stale" would send somebody to restart a process
 * that will refuse to start. They need to log in again, and only the status
 * says so.
 */
export function bridgeState(
  account: { status: string; lastSeenAt: Date | null },
  now: Date,
): BridgeState {
  if (account.status === 'signed_out') return 'signed_out';
  if (account.status === 'stopped') return 'stopped';
  const behind = secondsBehind(account.lastSeenAt, now);
  if (behind === null) return 'never';
  return behind <= LIVE_WINDOW_S ? 'live' : 'stale';
}
