import {
  classifyWithRules,
  isWorthKeeping,
  toMessageRow,
  type ChatRule,
  type ClientPhones,
  type DialogPeer,
  type MessageRow,
  type RawMessage,
  peerTitle,
} from './telegram-import';
import { unknownChatAction } from './unknown-chat';

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
   * A stranger, on an account that says it is a WORK number (0064): mint a
   * lead and keep the conversation on it. Carries the peer's identity because
   * the lead has to be named and reachable — that is the trade the switch
   * makes, and it is why the switch defaults to personal.
   */
  | { store: true; openLead: true; peer: { phone: string; title: string }; row: MessageRow }
  /**
   * A chat somebody attached to a lead by hand, from the tray (0065). The
   * lead already exists, so unlike `openLead` there is nothing to mint and
   * nothing to name — only where to put the message.
   */
  | { store: true; leadId: string; row: MessageRow }
  /**
   * A stranger on a PERSONAL number: a question, not an answer. Carries who
   * to ask ABOUT — a tray cannot offer an anonymous row — and deliberately
   * nothing about the message itself. Until somebody answers, no word of the
   * conversation is stored.
   */
  | { store: false; ask: true; peerId: bigint; phone: string; title: string }
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
 * Is this the plain «a client we know wrote» verdict?
 *
 * The `store: true` side of `LiveVerdict` is a union of three now — a known
 * client, a stranger a work account turns into a lead, and a chat somebody
 * attached to a lead by hand — and `if (!v.store)` narrows away exactly none
 * of that. Every consumer asking the question by hand is how a fourth
 * variant becomes five call sites to fix, which is what #591 was: green
 * locally, red on CI's typecheck, in files nobody had touched.
 *
 * So the question is asked once, here, and the guard travels with the type.
 */
export function isClientVerdict(
  verdict: LiveVerdict,
): verdict is { store: true; clientId: string; clientCode: string; row: MessageRow } {
  return verdict.store && !('openLead' in verdict) && !('leadId' in verdict);
}

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
  workAccount = false,
): LiveVerdict {
  /*
   * A hand-attached LEAD chat is answered here rather than inside
   * `classifyWithRules`, and the placement is the decision.
   *
   * That function answers «whose CLIENT chat is this», which is the only
   * question the history import can act on — widening its verdict would
   * ripple through every caller and teach `tg-import` a shape it has no use
   * for. Here the answer is already actionable: the lead exists, the message
   * has somewhere to go.
   *
   * It must come BEFORE the classifier, or a lead chat would fall through
   * `not_a_client` and — on a personal account — be put back on the tray as
   * a question somebody has already answered. `isSelf` still wins: Saved
   * Messages is not a customer under any decision anybody could write down.
   */
  const rule = rules.get(peer.id);
  if (!peer.isSelf && rule?.decision === 'include' && rule.leadId) {
    const leadRow = toMessageRow(peer.id, msg);
    if (!isWorthKeeping(leadRow)) return { store: false, reason: 'empty' };
    return { store: true, leadId: rule.leadId, row: leadRow };
  }

  const verdict = classifyWithRules(peer, clients, rules);
  if (!verdict.keep) {
    // Round 79: a stranger is no longer automatically nothing. Whether they
    // are a customer or the manager's own life is a question about the
    // NUMBER, and the account answers it about itself.
    // `not_a_client` is only reached once the number was visible, so the
    // non-null assertions below are the classifier's guarantee, not a guess.
    const phone = (peer.phone ?? '').trim() || null;
    const action = unknownChatAction(verdict, workAccount);
    if (action.action === 'open_lead') {
      const row = toMessageRow(peer.id, msg);
      if (!isWorthKeeping(row)) return { store: false, reason: 'empty' };
      return { store: true, openLead: true, peer: { phone: phone!, title: peerTitle(peer) }, row };
    }
    if (action.action === 'ask') {
      return { store: false, ask: true, peerId: peer.id, phone: phone!, title: peerTitle(peer) };
    }
    return { store: false, reason: verdict.reason };
  }
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
