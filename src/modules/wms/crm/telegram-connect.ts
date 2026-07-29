import { sessionKey } from './telegram-session';
import { saveAccount } from './telegram-accounts';

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
 * shape — is a pure function below, unit-tested.
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
 * Telegram's error names, folded to what a screen can say. The strings are
 * the library's RPC error messages — matched by inclusion because gramjs
 * wraps them differently between versions.
 */
export function connectErrorCode(message: string): string {
  const m = message.toUpperCase();
  if (m.includes('SESSION_PASSWORD_NEEDED')) return 'password_needed';
  if (m.includes('PASSWORD_HASH_INVALID')) return 'password_invalid';
  if (m.includes('PHONE_CODE_INVALID') || m.includes('PHONE_CODE_EXPIRED')) return 'code_invalid';
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
export function connectConfig(env: NodeJS.ProcessEnv = process.env): ConnectConfig | null {
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

export type ConnectStep =
  | { ok: true; step: 'code_sent' }
  | { ok: true; step: 'connected' }
  | { ok: false; error: string };

/** Step 1: ask Telegram to send the login code to the manager's phone. */
export async function beginTgLogin(userId: string, rawPhone: string): Promise<ConnectStep> {
  const config = connectConfig();
  if (!config) return { ok: false, error: 'not_configured' };
  const phone = normalizeTgPhone(rawPhone);
  if (!phone) return { ok: false, error: 'phone_invalid' };

  await dropPending(userId);
  try {
    const { TelegramClient } = await import('telegram');
    const { StringSession } = await import('telegram/sessions');
    const client = new TelegramClient(new StringSession(''), config.apiId, config.apiHash, {
      connectionRetries: 3,
    });
    if ((await client.connect()) === false) return { ok: false, error: 'failed' };
    const sent = (await client.sendCode(
      { apiId: config.apiId, apiHash: config.apiHash },
      phone,
    )) as { phoneCodeHash: string };
    pending.set(userId, {
      client: client as unknown as PendingLogin['client'],
      phone,
      phoneCodeHash: sent.phoneCodeHash,
      startedAt: Date.now(),
    });
    return { ok: true, step: 'code_sent' };
  } catch (err) {
    await dropPending(userId);
    return { ok: false, error: connectErrorCode(err instanceof Error ? err.message : String(err)) };
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

  try {
    const { Api } = await import('telegram');
    try {
      await entry.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: entry.phone,
          phoneCodeHash: entry.phoneCodeHash,
          phoneCode: code.trim(),
        }),
      );
    } catch (err) {
      const inner = connectErrorCode(err instanceof Error ? err.message : String(err));
      if (inner !== 'password_needed') {
        // A wrong CODE keeps the login alive — the person retypes it. Any
        // other failure is terminal for this attempt.
        if (inner !== 'code_invalid') await dropPending(userId);
        return { ok: false, error: inner };
      }
      // Two-step verification. Without the password the screen must ASK,
      // keeping the login alive; with it, finish the job.
      if (!password) return { ok: false, error: 'password_needed' };
      const { computeCheck } = await import('telegram/Password');
      const srp = await entry.client.invoke(new Api.account.GetPassword());
      await entry.client.invoke(
        new Api.auth.CheckPassword({
          password: await computeCheck(srp as never, password),
        }),
      );
    }

    const session = String(entry.client.session.save());
    await dropPending(userId);
    await saveAccount({ managerUserId: userId, tgPhone: entry.phone, session });
    return { ok: true, step: 'connected' };
  } catch (err) {
    const codeName = connectErrorCode(err instanceof Error ? err.message : String(err));
    // A wrong 2FA password also keeps the login alive for another try.
    if (codeName !== 'password_invalid') await dropPending(userId);
    return { ok: false, error: codeName };
  }
}
