import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Who is this, really?
 *
 * A Mini App runs in a webview the client controls: everything it sends can be
 * edited by whoever holds the phone, so `user.id` on its own is worth nothing
 * — a client could type another client's chat id and read their cargo and
 * their debt. Telegram's answer is `initData`, signed with the bot token,
 * which only the server has. That signature is the WHOLE of the security here.
 *
 * The algorithm, from Telegram's own documentation, and every step matters:
 *
 *   secret = HMAC_SHA256(key: "WebAppData", message: <bot token>)
 *   check  = every field EXCEPT `hash`, sorted alphabetically by key,
 *            rendered `key=value` with the values URL-DECODED once,
 *            joined by a single \n
 *   valid ⇔ hex(HMAC_SHA256(key: secret, message: check)) === hash
 *
 * Note the inversion: the constant is the KEY and the token is the MESSAGE,
 * which is the reverse of what the pseudocode's argument order suggests and
 * the commonest way to get this wrong. It fails closed — nobody can log in —
 * so at least it is loud.
 *
 * `signature` STAYS IN the string. Telegram excludes it only from the separate
 * third-party Ed25519 check, and copying that recipe here passes every test
 * built from hand-made initData and then fails for every real user on a modern
 * client: a silent, total auth outage that no fixture would have caught.
 */

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export type InitDataResult =
  | { ok: true; user: TelegramUser; chatId: number; authDate: Date }
  | { ok: false; reason: 'empty' | 'no_hash' | 'bad_signature' | 'expired' | 'no_user' };

/**
 * How long an `initData` blob may be reused.
 *
 * `auth_date` is stamped when the app is OPENED and never refreshes while it
 * stays open, so a short window would log out a client who left the cabinet on
 * their screen. Validated once at open; everything after that rides the
 * session this mints.
 */
export const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

export function verifyInitData(
  initData: string,
  botToken: string,
  now: Date = new Date(),
  maxAgeSeconds: number = INIT_DATA_MAX_AGE_SECONDS,
): InitDataResult {
  // A page opened OUTSIDE Telegram has no initData at all. Treated as a
  // refusal rather than an empty-string signature check, because an empty
  // check-string can be signed like any other.
  if (!initData) return { ok: false, reason: 'empty' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no_hash' };

  const pairs: string[] = [];
  for (const [key, value] of params) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');

  // Constant-time: a plain === leaks how much of the hash was right, one byte
  // at a time, to anyone willing to make enough requests.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate || now.getTime() / 1000 - authDate > maxAgeSeconds) {
    return { ok: false, reason: 'expired' };
  }

  let user: TelegramUser;
  try {
    user = JSON.parse(params.get('user') ?? '') as TelegramUser;
  } catch {
    return { ok: false, reason: 'no_user' };
  }
  if (!user?.id) return { ok: false, reason: 'no_user' };

  return { ok: true, user, chatId: user.id, authDate: new Date(authDate * 1000) };
}
