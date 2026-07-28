import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * The one reversible secret this system stores.
 *
 * Everything else kept about a credential here is a one-way hash — a login
 * password, a browser session, a driver's pairing token — because nothing ever
 * needs the original back. A Telegram session string is different: it IS the
 * credential, it has to be handed to the library on every reconnect, and it
 * unlocks a manager's PERSONAL account, not a company one. So it is encrypted
 * rather than hashed, and that fact deserves the extra care on this page.
 *
 * AES-256-GCM: authenticated, so a row edited in the database fails to open
 * instead of decrypting to something. The key is `TG_SESSION_KEY` in the
 * server `.env` — never in the repo, never in a commit, never in chat — and it
 * is deliberately NOT derived from `SESSION_SECRET`: rotating the web session
 * secret must not lock twelve people out of their own Telegram, and leaking
 * one must not hand over the other.
 *
 * The manager's user id is bound in as additional authenticated data, so a
 * blob lifted from one row and pasted into another will not open. Without it,
 * a person with write access to one table could point their own row at
 * somebody else's session and read that person's chats as themselves.
 */

/** `v1` prefixes the payload so a future scheme can be told apart, not guessed. */
const VERSION = 'v1';
const IV_BYTES = 12; // 96 bits, the size GCM is defined for
const KEY_BYTES = 32;

export class SessionKeyError extends Error {}

/**
 * The key from the environment, checked properly.
 *
 * A short key is the failure worth catching loudly: node would accept a
 * 16-byte one and quietly give AES-128, so the check is on the decoded length
 * rather than on the string.
 */
export function sessionKey(raw = process.env.TG_SESSION_KEY): Buffer {
  const value = (raw ?? '').trim();
  if (!value) {
    throw new SessionKeyError(
      'TG_SESSION_KEY is not set — generate one with: openssl rand -base64 32',
    );
  }
  const key = Buffer.from(value, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new SessionKeyError(
      `TG_SESSION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length} — generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

/** Encrypt a session string for storage, bound to the manager it belongs to. */
export function sealSession(session: string, ownerId: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(ownerId, 'utf8'));
  const body = Buffer.concat([cipher.update(session, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(
    '.',
  );
}

/**
 * Decrypt one back. Throws on a wrong key, a wrong owner, or a tampered row —
 * all three are the same answer on purpose: the blob is not usable here.
 */
export function openSession(sealed: string, ownerId: string, key: Buffer): string {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || !body) {
    throw new SessionKeyError('stored Telegram session is not in the expected format');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(ownerId, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(body, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Whether a sealed blob still opens with the key the server currently holds.
 *
 * Used by the status screen so "the bridge is down" can distinguish a key that
 * was rotated (fix the `.env`) from a session Telegram itself has ended (the
 * manager has to log in again) — two problems with completely different
 * answers, which otherwise both read as "not connected".
 */
export function sessionOpens(sealed: string, ownerId: string, key: Buffer): boolean {
  try {
    openSession(sealed, ownerId, key);
    return true;
  } catch {
    return false;
  }
}
