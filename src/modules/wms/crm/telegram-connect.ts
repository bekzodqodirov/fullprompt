import { sessionKey } from './telegram-session';
import { phoneHolder, saveAccount } from './telegram-accounts';

/**
 * Connecting a manager's Telegram from the APP — round 21, the owner:
 * «akkauntlarni sistemamizga ulashni osonlashtirishimiz kerak».
 *
 * Until now a login meant the owner running `pnpm tg-login` on the server
 * while the manager read a code off their phone to him. This module drives
 * the same three Telegram steps — send code, type code, maybe a 2FA
 * password — from a screen, for the manager's OWN account only.
 *
 * The half-finished login lives in THIS PROCESS's memory (`pending` below):
 * a gramjs client that has asked Telegram for a code holds the DC
 * negotiation that code is valid for, so the same client must finish the
 * job. That is fine here because the standalone server is one process; it
 * also means a deploy in the middle of a login simply expires it — the
 * person taps «kod yuborish» again, which costs one more SMS and nothing
 * else. Nothing is written to the database until the login SUCCEEDS, and
 * then only through `saveAccount`, encrypted like every session before it.
 *
 * The gramjs calls are a thin shell (the tg-import/tg-listen discipline):
 * everything decidable without a network — expiry, error naming, phone
 * shape, which step a press is — is a function below, unit-tested.
 */

/** A code is short-lived by Telegram's own rules; ours must not outlive it. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

export function pendingExpired(startedAt: number, now: number): boolean {
  return now - startedAt > PENDING_TTL_MS;
}

/** The shape a Telegram login phone must have — digits, plus, no spaces. */
export function normalizeTgPhone(raw: string): string | null {
  const phone = raw.trim().replace(/[\s()-]/g, '');
  return /^\+\d{9,15}$/.test(phone) ? phone : null;
}

/**
 * A login code is digits and nothing else. Whatever else arrives — the
 * space Telegram's own message puts in «12 345», a trailing dot from a
 * paste — is dropped here rather than handed to Telegram as a wrong code.
 */
export function normalizeTgCode(raw: string): string {
  return raw.replace(/\D/g, '');
}

/**
 * Every refusal the connect screen puts into words. Each member has a
 * sentence under `crm.connectErrors` in all four bundles — the test reads
 * this list out of the file, so a member added here without its sentence is
 * a red test and not a key printed on a manager's screen (#163).
 */
export type ConnectError =
  | 'not_configured'
  | 'phone_invalid'
  | 'phone_unregistered'
  | 'phone_taken'
  | 'code_invalid'
  | 'password_needed'
  | 'password_invalid'
  | 'flood_wait'
  | 'expired'
  | 'failed';

/**
 * Telegram's error names, folded to what a screen can say. The strings are
 * the library's RPC error messages — matched by inclusion because gramjs
 * wraps them differently between versions.
 *
 * An EXPIRED code is not a wrong one: retyping it can never work, so it
 * ends the attempt and asks for a new code instead of «check and retype»,
 * which sent the person round the same dead code until the login timed out.
 */
export function connectErrorCode(message: string): ConnectError {
  const m = message.toUpperCase();
  if (m.includes('SESSION_PASSWORD_NEEDED')) return 'password_needed';
  if (m.includes('PASSWORD_HASH_INVALID')) return 'password_invalid';
  if (m.includes('PHONE_CODE_EXPIRED') || m.includes('AUTH_RESTART')) return 'expired';
  if (m.includes('PHONE_CODE_INVALID') || m.includes('PHONE_CODE_EMPTY')) return 'code_invalid';
  if (m.includes('PHONE_NUMBER_UNOCCUPIED')) return 'phone_unregistered';
  if (m.includes('PHONE_NUMBER_INVALID') || m.includes('PHONE_NUMBER_BANNED'))
    return 'phone_invalid';
  if (m.includes('FLOOD')) return 'flood_wait';
  return 'failed';
}

export interface ConnectConfig {
  apiId: number;
  apiHash: string;
}

/** Null when the server is not set up for Telegram logins at all. */
export function connectConfig(
  env: Record<string, string | undefined> = process.env,
): ConnectConfig | null {
  const apiId = Number(env.TELEGRAM_API_ID);
  const apiHash = env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) return null;
  // The key is checked BEFORE Telegram is asked to send anything: making a
  // person type a code and then failing on a missing key wastes the code
  // (the tg-login lesson, kept).
  try {
    sessionKey();
  } catch {
    return null;
  }
  return { apiId, apiHash };
}

/** The two network steps of a login's second half. */
export interface LoginSteps {
  signIn(code: string): Promise<void>;
  checkPassword(password: string): Promise<void>;
}

export type FinishResult =
  | { ok: true }
  | {
      ok: false;
      error: ConnectError;
      /** The login is still usable: a wrong code, a wrong or missing password. */
      alive: boolean;
    };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One press of «Ulash» — which step it is, decided from what the login has
 * already got, never from what the form happens to post.
 *
 * `codeAccepted` is the fact this turns on. Telegram answers a right code on
 * a two-step account with SESSION_PASSWORD_NEEDED: the code is SPENT, and
 * the login now wants the password and nothing else. The first version
 * signed in again with whatever code the second press carried — and the
 * form's code box had been emptied by React's reset after the first press,
 * so the password press sent an EMPTY code, Telegram refused it, the login
 * was dropped and «Bo'lmadi» was printed. Every manager whose Telegram has
 * a password was refused, every time. gramjs's own `signInUser` and Telethon
 * both go straight to the password once the code has been taken; so does
 * this.
 */
export async function finishLogin(
  state: { codeAccepted: boolean },
  steps: LoginSteps,
  rawCode: string,
  password: string | undefined,
): Promise<FinishResult> {
  if (!state.codeAccepted) {
    const code = normalizeTgCode(rawCode);
    if (!code) return { ok: false, error: 'code_invalid', alive: true };
    try {
      await steps.signIn(code);
      return { ok: true };
    } catch (err) {
      const error = connectErrorCode(messageOf(err));
      // A wrong CODE keeps the login alive — the person retypes it. Any
      // other failure is terminal for this attempt.
      if (error !== 'password_needed') return { ok: false, error, alive: error === 'code_invalid' };
      state.codeAccepted = true;
    }
  }
  // Two-step verification. Without the password the screen must ASK,
  // keeping the login alive; with it, finish the job.
  if (!password) return { ok: false, error: 'password_needed', alive: true };
  try {
    await steps.checkPassword(password);
    return { ok: true };
  } catch (err) {
    const error = connectErrorCode(messageOf(err));
    // A wrong 2FA password also keeps the login alive for another try.
    return { ok: false, error, alive: error === 'password_invalid' };
  }
}

interface PendingLogin {
  /** The gramjs client mid-login. Typed loosely: it never leaves this file. */
  client: {
    connect(): Promise<boolean>;
    disconnect(): Promise<void>;
    destroy(): Promise<void>;
    invoke(request: unknown): Promise<unknown>;
    session: { save(): unknown };
  };
  phone: string;
  phoneCodeHash: string;
  startedAt: number;
  /** Telegram took the code and asked for the two-step password. */
  codeAccepted: boolean;
}

/** Per MANAGER: a second «kod yuborish» replaces the first, never joins it. */
const pending = new Map<string, PendingLogin>();

async function dropPending(userId: string): Promise<void> {
  const entry = pending.get(userId);
  pending.delete(userId);
  if (entry) {
    await entry.client.disconnect().catch(() => {});
    await entry.client.destroy().catch(() => {});
  }
}

/**
 * Why an attempt ended, in the container's log. The screen gets a sentence
 * and the log gets Telegram's own words — a «Bo'lmadi» nobody can explain
 * is how this flow broke for months without anybody being able to say why.
 * Never the code, the password or the session.
 */
function logRefusal(userId: string, step: 'begin' | 'finish' | 'save', error: string, raw?: string) {
  console.warn(`[tg-connect] ${step} refused for user ${userId}: ${error}${raw ? ` (${raw})` : ''}`);
}

export type ConnectStep =
  | { ok: true; step: 'code_sent' }
  | { ok: true; step: 'connected' }
  | { ok: false; error: ConnectError; holder?: string };

/** Step 1: ask Telegram to send the login code to the manager's phone. */
export async function beginTgLogin(userId: string, rawPhone: string): Promise<ConnectStep> {
  const config = connectConfig();
  if (!config) return { ok: false, error: 'not_configured' };
  const phone = normalizeTgPhone(rawPhone);
  if (!phone) return { ok: false, error: 'phone_invalid' };

  // One Telegram account belongs to ONE person here (`tg_phone` is unique,
  // 0038 — two listeners on one account is what gets it flagged). Asked
  // BEFORE Telegram sends a code: the first version found out at the very
  // end, when the insert refused, and printed «Bo'lmadi» over a code the
  // person had already typed — with nothing to say whose number it was.
  const holder = await phoneHolder(phone, userId);
  if (holder) {
    logRefusal(userId, 'begin', 'phone_taken');
    return { ok: false, error: 'phone_taken', holder: holder.name };
  }

  await dropPending(userId);
  try {
    const { TelegramClient } = await import('telegram');
    const { StringSession } = await import('telegram/sessions');
    const client = new TelegramClient(new StringSession(''), config.apiId, config.apiHash, {
      connectionRetries: 3,
    });
    if ((await client.connect()) === false) {
      logRefusal(userId, 'begin', 'failed', 'connect returned false');
      return { ok: false, error: 'failed' };
    }
    const sent = (await client.sendCode(
      { apiId: config.apiId, apiHash: config.apiHash },
      phone,
    )) as { phoneCodeHash: string };
    pending.set(userId, {
      client: client as unknown as PendingLogin['client'],
      phone,
      phoneCodeHash: sent.phoneCodeHash,
      startedAt: Date.now(),
      codeAccepted: false,
    });
    return { ok: true, step: 'code_sent' };
  } catch (err) {
    await dropPending(userId);
    const error = connectErrorCode(messageOf(err));
    logRefusal(userId, 'begin', error, messageOf(err));
    return { ok: false, error };
  }
}

/**
 * Step 2: the code (and, for a 2FA account, the password) finishes the login.
 * On success the session is sealed and stored and the transient client is
 * torn down — from here the LISTENER owns the connection, alone.
 */
export async function completeTgLogin(
  userId: string,
  code: string,
  password?: string,
): Promise<ConnectStep> {
  const entry = pending.get(userId);
  if (!entry) return { ok: false, error: 'expired' };
  if (pendingExpired(entry.startedAt, Date.now())) {
    await dropPending(userId);
    return { ok: false, error: 'expired' };
  }

  const { Api } = await import('telegram');
  const steps: LoginSteps = {
    signIn: async (phoneCode) => {
      await entry.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: entry.phone,
          phoneCodeHash: entry.phoneCodeHash,
          phoneCode,
        }),
      );
    },
    checkPassword: async (secret) => {
      const { computeCheck } = await import('telegram/Password');
      const srp = await entry.client.invoke(new Api.account.GetPassword());
      await entry.client.invoke(
        new Api.auth.CheckPassword({ password: await computeCheck(srp as never, secret) }),
      );
    },
  };

  const done = await finishLogin(entry, steps, code, password);
  if (!done.ok) {
    if (done.error !== 'password_needed') logRefusal(userId, 'finish', done.error);
    if (!done.alive) await dropPending(userId);
    return { ok: false, error: done.error };
  }

  try {
    const session = String(entry.client.session.save());
    await saveAccount({ managerUserId: userId, tgPhone: entry.phone, session });
  } catch (err) {
    // The login is authorised on Telegram's side and we cannot keep it:
    // end it there too rather than leave a session nobody holds.
    await entry.client.invoke(new Api.auth.LogOut()).catch(() => {});
    await dropPending(userId);
    // Somebody connected this number in the minutes since the code was sent.
    if ((err as { code?: string }).code === '23505') {
      const holder = await phoneHolder(entry.phone, userId);
      logRefusal(userId, 'save', 'phone_taken');
      return { ok: false, error: 'phone_taken', holder: holder?.name };
    }
    logRefusal(userId, 'save', 'failed', messageOf(err));
    return { ok: false, error: 'failed' };
  }
  await dropPending(userId);
  return { ok: true, step: 'connected' };
}
