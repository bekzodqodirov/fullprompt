/**
 * When a reply may go out, and when it must not — phase 4.
 *
 * Phases 1-3 rested on one sentence: "there is no code path here that sends."
 * That sentence was the safety argument, because SENDING is what gets a
 * personal Telegram account limited or banned, and these are twelve people's
 * own accounts, not company ones. From here it is no longer true, so the
 * argument has to be rebuilt out of rules — and rules only protect anybody if
 * they are in code rather than in a document.
 *
 * Every decision lives here, pure, so each one can be tested without an
 * account, a network or a phone. The listener is the shell that obeys them.
 *
 * What actually gets accounts flagged, in order:
 *   1. messages to people who never wrote to you first,
 *   2. many messages in a short time,
 *   3. the same text to many different people,
 *   4. ignoring a FLOOD_WAIT and carrying on.
 * There is a rule below for each, and `sendingLimits` states the numbers in
 * one place so they can be argued with.
 */

export interface SendLimits {
  /** Per account, per rolling minute. */
  perMinute: number;
  /** Per account, per rolling 24 hours. */
  perDay: number;
  /** Per CHAT, per rolling minute — a stuck retry must not hammer one person. */
  perChatPerMinute: number;
}

/**
 * Deliberately far below anything Telegram is known to enforce.
 *
 * The business does not need volume: this is a manager answering a customer
 * who asked a question, at human speed. Twelve managers answering flat out for
 * a whole day would not reach 200 each. So the caps are set where a HUMAN
 * cannot hit them but a bug can — a loop that re-queues, a retry that never
 * gives up, a paste of the same message to every client. Their whole purpose
 * is to make a software fault cost one account nothing.
 */
export const DEFAULT_LIMITS: SendLimits = {
  perMinute: 12,
  perDay: 200,
  perChatPerMinute: 4,
};

export interface SendContext {
  /** Sends from this account in the last 60 s. */
  sentLastMinute: number;
  /** Sends from this account in the last 24 h. */
  sentLastDay: number;
  /** Sends to THIS chat in the last 60 s. */
  sentToChatLastMinute: number;
  /** Has this client ever written to us on this account? */
  clientHasWrittenFirst: boolean;
  /** The company-wide switch. Off until the owner turns it on. */
  sendingEnabled: boolean;
  /** Set while a FLOOD_WAIT from Telegram is still in force. */
  floodWaitUntil: Date | null;
  /** The account is connected and the listener is running. */
  bridgeLive: boolean;
}

export type SendRefusal =
  | 'sending_disabled'
  | 'never_wrote_first'
  | 'flood_wait'
  | 'rate_minute'
  | 'rate_day'
  | 'rate_chat'
  | 'bridge_down'
  | 'empty';

export type SendVerdict = { ok: true } | { ok: false; reason: SendRefusal };

/**
 * May this message be QUEUED?
 *
 * Checked by the screen and again by the action, so the answer is the same
 * whether a person pressed the button or something posted the form.
 *
 * `bridge_down` is a refusal at queue time on purpose. The row would be
 * perfectly valid and would go out whenever the listener came back — but
 * "whenever" might be tomorrow, and a manager who typed an answer and saw it
 * accepted believes the client has it. Better to refuse and say why.
 */
export function canQueue(
  body: string,
  ctx: SendContext,
  limits = DEFAULT_LIMITS,
  // A photo makes an empty body legitimate (the body is then a caption) —
  // but it never relaxes anything else: a photo costs the same rate slot.
  hasAttachment = false,
): SendVerdict {
  if (!hasAttachment && body.trim().length === 0) return { ok: false, reason: 'empty' };
  if (!ctx.sendingEnabled) return { ok: false, reason: 'sending_disabled' };
  // The single most important rule. Unsolicited outbound to somebody who never
  // messaged you is what "report spam" is for, and a few reports is all it
  // takes. Replying inside a conversation the client started is the safe half
  // of Telegram, and it is also the only thing this business needs.
  if (!ctx.clientHasWrittenFirst) return { ok: false, reason: 'never_wrote_first' };
  if (!ctx.bridgeLive) return { ok: false, reason: 'bridge_down' };
  return withinLimits(ctx, limits);
}

/**
 * May this message be SENT right now?
 *
 * Separate from `canQueue` because time passes between the two: a row queued
 * when the account was well under its limit may reach the front of the queue
 * after a burst, and the limits are about the moment of sending. The listener
 * calls this immediately before handing anything to Telegram.
 */
export function canSendNow(ctx: SendContext, limits = DEFAULT_LIMITS, now = new Date()): SendVerdict {
  if (!ctx.sendingEnabled) return { ok: false, reason: 'sending_disabled' };
  if (!ctx.clientHasWrittenFirst) return { ok: false, reason: 'never_wrote_first' };
  // Telegram told us to wait. Ignoring it is the fastest route to a ban, and
  // the wait is not advice — it is the terms of continuing to have an account.
  if (ctx.floodWaitUntil && ctx.floodWaitUntil.getTime() > now.getTime()) {
    return { ok: false, reason: 'flood_wait' };
  }
  return withinLimits(ctx, limits);
}

function withinLimits(ctx: SendContext, limits: SendLimits): SendVerdict {
  if (ctx.sentToChatLastMinute >= limits.perChatPerMinute) {
    return { ok: false, reason: 'rate_chat' };
  }
  if (ctx.sentLastMinute >= limits.perMinute) return { ok: false, reason: 'rate_minute' };
  if (ctx.sentLastDay >= limits.perDay) return { ok: false, reason: 'rate_day' };
  return { ok: true };
}

/**
 * How long to hold off after Telegram says FLOOD_WAIT.
 *
 * Its own number, plus a second of slack, and never less than a second even if
 * it says zero. Capped at an hour: beyond that something is wrong that waiting
 * will not fix, and a process that sleeps for six hours looks identical to a
 * process that has died.
 */
export const MAX_FLOOD_WAIT_S = 3600;

export function floodWaitUntil(seconds: number, now = new Date()): Date {
  const wait = Math.min(Math.max(Math.ceil(seconds) + 1, 1), MAX_FLOOD_WAIT_S);
  return new Date(now.getTime() + wait * 1000);
}

/**
 * Is this error worth another attempt, or is it final?
 *
 * The distinction that matters is not "did it work" but "will trying again
 * make it worse". A blocked user and a privacy setting are permanent facts
 * about the other person: retrying those is exactly the pattern that reads as
 * abuse. A network drop is nobody's decision and is worth retrying.
 */
export const MAX_ATTEMPTS = 3;

export function isPermanentSendError(message: string): boolean {
  const m = message.toUpperCase();
  return [
    'USER_IS_BLOCKED', // they blocked us; every retry is a knock on a closed door
    'PEER_FLOOD', // Telegram already thinks we are spamming
    'USER_PRIVACY_RESTRICTED',
    'USER_DEACTIVATED',
    'CHAT_WRITE_FORBIDDEN',
    'INPUT_USER_DEACTIVATED',
    'YOU_BLOCKED_USER',
    'MESSAGE_EMPTY',
    'MESSAGE_TOO_LONG',
  ].some((code) => m.includes(code));
}

/**
 * Telegram has ended our SESSION — this is not about the message at all.
 *
 * Found the hard way (round 49): the owner's account was revoked and every
 * reply came back `401: SESSION_REVOKED`, which `isPermanentSendError` did not
 * recognise, so the listener printed «qayta urinaman» and hammered a dead
 * session every three seconds until each row burned its three attempts and
 * failed. Meanwhile the heartbeat kept being written, so the screen said the
 * bridge was LIVE and went on accepting replies that could never leave.
 *
 * Kept apart from `isPermanentSendError` because the two demand different
 * things: that one is a fact about the RECIPIENT and only the message dies;
 * this is a fact about US, and the account has to be marked signed out so the
 * compose box says «log in again» instead of taking dictation for nobody.
 */
export function isSessionDead(message: string): boolean {
  const m = message.toUpperCase();
  return [
    'SESSION_REVOKED', // somebody pressed «terminate session» in Telegram
    'AUTH_KEY_UNREGISTERED',
    'AUTH_KEY_INVALID',
    'AUTH_KEY_DUPLICATED', // the same session used from two places at once
    'SESSION_EXPIRED',
    'USER_DEACTIVATED_BAN',
  ].some((code) => m.includes(code));
}

/** Telegram's own ceiling for one text message. */
export const MAX_BODY_CHARS = 4096;

export function bodyTooLong(body: string): boolean {
  // Counted in code points rather than UTF-16 units: Telegram counts
  // characters, and a message of emoji would otherwise be refused by us while
  // being perfectly acceptable to it.
  return [...body.trim()].length > MAX_BODY_CHARS;
}

/**
 * A photo's caption has its own, much lower ceiling. Refused at queue time
 * rather than truncated or split: a silent cut loses words a customer was
 * meant to read, and a second send is a second rate-limit slot.
 */
export const MAX_CAPTION_CHARS = 1024;

export function captionTooLong(body: string): boolean {
  return [...body.trim()].length > MAX_CAPTION_CHARS;
}

/**
 * How long a reply may sit «in flight» before the screen must stop calling it
 * queued (round 48, the owner's item 14).
 *
 * A row goes to `sending` the instant the listener claims it and leaves that
 * state a second later — unless the listener sent the message and could not
 * write down that it had. Five minutes is far longer than any real send and
 * far shorter than the hours his stuck row sat there reading «navbatda» while
 * the client had already answered it.
 */
export const STUCK_SENDING_MS = 5 * 60_000;

export type OutboxLabel = 'queued' | 'sending' | 'stuck' | 'failed';

/**
 * What the thread should CALL a row that has not been marked sent.
 *
 * The distinction that matters is the last one: «stuck» does not mean the
 * message failed and it does not mean it is waiting. It means nobody here
 * knows, and the one person who can find out is the manager whose Telegram it
 * left from — so the screen says «check it» instead of guessing.
 */
export function outboxLabel(
  status: string,
  claimedSince: Date | null,
  now: Date = new Date(),
): OutboxLabel {
  if (status === 'failed') return 'failed';
  if (status !== 'sending') return 'queued';
  if (!claimedSince) return 'sending';
  return now.getTime() - claimedSince.getTime() > STUCK_SENDING_MS ? 'stuck' : 'sending';
}

/**
 * Is this "cannot reach the database" rather than "Telegram refused"?
 *
 * The distinction decides whether a claimed reply goes back in the queue or is
 * marked failed, and getting it wrong costs a customer a message. `EAI_AGAIN`
 * is what the owner's server actually produced — Docker's embedded DNS stopped
 * resolving `postgres` for the listener's container while everything else kept
 * working, for days. The rest are the other shapes the same thing takes.
 */
export function isDbUnreachable(message: string): boolean {
  return [
    'EAI_AGAIN',
    'ENOTFOUND',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'Connection terminated',
    'terminating connection',
  ].some((code) => message.includes(code));
}
