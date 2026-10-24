import { isDbUnreachable, isSessionDead } from './telegram-send';

/**
 * What a Telegram error MEANS for the account (review ban-1), and whether the
 * pump may claim anything at all.
 *
 * Today's pump checked two things before it claimed a row — the company
 * switch and an in-memory flood clock — and a PEER_FLOOD failed one message
 * while the next was tried three seconds later. PEER_FLOOD, USER_RESTRICTED
 * and FROZEN_* are Telegram saying the ACCOUNT is already limited: every
 * further send, human or machine, is evidence against it. So the answer is a
 * closed union read off the error, and the account's pause is a row the pump
 * reads every tick (`tg_account_guard`), persisted so a restart cannot forget
 * it, cleared only by a person.
 *
 * Pure. Tests build the errors BY gramjs (`RPCMessageToError`), never by hand.
 */

export type PauseKind = 'peer_flood' | 'restricted' | 'frozen' | 'flood_repeat' | 'blocks';

export type TgErrorKind =
  /** The account is limited: pause it, human sends included. */
  | { kind: 'restricted'; pause: Extract<PauseKind, 'peer_flood' | 'restricted' | 'frozen'>; code: string }
  /** A wait Telegram ordered — obeyed uncapped. */
  | { kind: 'flood'; seconds: number; code: string }
  /** Our session is gone — the account is signed out. */
  | { kind: 'session'; code: string }
  /** A fact about the RECIPIENT (blocked us, privacy, deactivated): this chat, finally. */
  | { kind: 'recipient_final'; code: string }
  /** The message itself is refused (empty, too long): this message, finally. */
  | { kind: 'message_final'; code: string }
  /** Telegram already holds a message with this random_id — it WAS sent (ban-5). */
  | { kind: 'duplicate'; code: string }
  /** Our database, not Telegram. */
  | { kind: 'db'; code: string }
  /** A network blip, a timeout, an unknown answer. */
  | { kind: 'transient'; code: string };

const RESTRICTED: readonly [string, Extract<PauseKind, 'peer_flood' | 'restricted' | 'frozen'>][] = [
  ['PEER_FLOOD', 'peer_flood'],
  ['USER_RESTRICTED', 'restricted'],
  ['FROZEN_', 'frozen'],
];

const RECIPIENT_FINAL = [
  'USER_IS_BLOCKED',
  'YOU_BLOCKED_USER',
  'USER_PRIVACY_RESTRICTED',
  'USER_DEACTIVATED',
  'INPUT_USER_DEACTIVATED',
  'CHAT_WRITE_FORBIDDEN',
  'PEER_ID_INVALID',
] as const;

const MESSAGE_FINAL = ['MESSAGE_EMPTY', 'MESSAGE_TOO_LONG', 'ENTITY_BOUNDS_INVALID', 'ENTITIES_TOO_LONG'] as const;

function codeOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const name = (err as { errorMessage?: unknown }).errorMessage;
  return typeof name === 'string' && name ? `${name} ${err.message}` : err.message;
}

export function tgErrorKind(err: unknown): TgErrorKind {
  const text = codeOf(err);
  const upper = text.toUpperCase();
  if (upper.includes('RANDOM_ID_DUPLICATE')) return { kind: 'duplicate', code: 'RANDOM_ID_DUPLICATE' };
  // Session before restriction: USER_DEACTIVATED_BAN is the account itself gone.
  if (isSessionDead(text)) return { kind: 'session', code: text };
  for (const [needle, pause] of RESTRICTED) {
    if (upper.includes(needle)) return { kind: 'restricted', pause, code: needle };
  }
  const seconds = (err as { seconds?: unknown } | null)?.seconds;
  if (typeof seconds === 'number' && Number.isFinite(seconds)) return { kind: 'flood', seconds, code: 'FLOOD_WAIT' };
  const wait = /(?:FLOOD_WAIT|FLOOD_PREMIUM_WAIT|SLOWMODE_WAIT)_(\d+)/u.exec(upper);
  if (wait) return { kind: 'flood', seconds: Number(wait[1]), code: 'FLOOD_WAIT' };
  for (const code of RECIPIENT_FINAL) if (upper.includes(code)) return { kind: 'recipient_final', code };
  for (const code of MESSAGE_FINAL) if (upper.includes(code)) return { kind: 'message_final', code };
  if (isDbUnreachable(text)) return { kind: 'db', code: text };
  return { kind: 'transient', code: text };
}

export type PumpRefusal = 'sending_disabled' | 'account_paused' | 'flood_wait';

/**
 * May the pump claim ANY row on this account now (human rows included)?
 * Asked before every claim, from the guard row read that tick.
 */
export function pumpGate(input: {
  sendingEnabled: boolean;
  pausedAt: Date | null;
  floodUntil: Date | null;
  now: Date;
}): { ok: true } | { ok: false; reason: PumpRefusal } {
  if (!input.sendingEnabled) return { ok: false, reason: 'sending_disabled' };
  if (input.pausedAt) return { ok: false, reason: 'account_paused' };
  if (input.floodUntil && input.floodUntil.getTime() > input.now.getTime()) return { ok: false, reason: 'flood_wait' };
  return { ok: true };
}

/** When a wait Telegram ordered ends — its own number plus a second, never shortened (ban-2). */
export function floodEnds(seconds: number, now: Date): Date {
  return new Date(now.getTime() + (Math.max(0, Math.ceil(seconds)) + 1) * 1000);
}

/**
 * gramjs's own words when it sleeps through a wait inside `invoke` (≤ the
 * client's floodSleepThreshold, 60 s): «Sleeping for 12s on flood wait (Caused
 * by messages.SendMessage)». Read by the listener's logger hook so the sleep
 * becomes a row instead of a silence (ban-2's DEVIATION: the threshold stays).
 */
export function parseFloodSleep(line: string): { seconds: number; method: string } | null {
  const m = /Sleeping for (\d+)s on flood wait \(Caused by ([\w.]+)\)/u.exec(line);
  return m ? { seconds: Number(m[1]), method: m[2]! } : null;
}
