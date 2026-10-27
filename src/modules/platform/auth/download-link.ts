import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A download that works without the login cookie (the owner, 2026-10-27:
 * «filelar telefonda skachat bolmayabti … download unsuccessful … 3 c» —
 * the system opened from a Telegram «↗️ Ochish» button).
 *
 * Telegram's in-app browser does not download a file itself: it hands the
 * address to the phone's download manager, which fetches it as a stranger —
 * no `gsr_session` cookie — so every file route answered 401 and the phone
 * said «Download unsuccessful». The same is true of any webview that does
 * this, and of a link handed to an outside browser where nobody is logged in.
 *
 * So a click on a file link first asks the server for a LINK: an address that
 * names one user, one path and a deadline, signed with a key derived from
 * `SESSION_SECRET`. The link is what the download manager fetches; the server
 * checks the signature and serves the path exactly as that user would see it
 * — every file route keeps its own door, nothing is widened. A link is a
 * bearer for ONE path for `DOWNLOAD_TTL_MS`, never a session: it cannot open
 * a page, and the person's grants are read afresh when it is used.
 *
 * No key, no links: without a real `SESSION_SECRET` (`MIN_SECRET`, not a
 * `PUBLISHED` value) every function here answers null and the screens fall
 * back to the plain address, because a signature under a guessable key is an
 * open door.
 */

/** Long enough for Telegram's «Download file?» sheet and a slow tap, short enough not to matter if it leaks. */
export const DOWNLOAD_TTL_MS = 10 * 60_000;

const MIN_SECRET = 8;
const MAX_PATH = 2048;

/**
 * Values that are in the repository and so are no secret: `.env.example`'s
 * line copied as it stands, and the local file driver's fallback. A link
 * signed under one is forgeable by anyone who has read this code.
 */
const PUBLISHED = new Set(['generate-a-long-random-string', 'dev-secret']);

/** The header pair the link route sets on its own request to the file route. */
export const INTERNAL_HEADER = 'x-gsr-internal';
export const DELEGATED_USER_HEADER = 'x-gsr-dl-user';

function secret(): string | null {
  const value = process.env.SESSION_SECRET ?? '';
  return value.length >= MIN_SECRET && !PUBLISHED.has(value) ? value : null;
}

function mac(purpose: string, value: string): string | null {
  const key = secret();
  if (!key) return null;
  return createHmac('sha256', key).update(`${purpose}:${value}`).digest('base64url');
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // `timingSafeEqual` THROWS on a length mismatch — a short forgery must be a
  // «no», not a 500 (round 83's rule for every signature in this codebase).
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Which addresses a link may name: a GET file route of THIS app, given as a
 * path. Never the link route itself (a link to a link), never anything that
 * could leave the origin or climb out of `/api/`.
 */
export function linkablePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH) return null;
  if (!raw.startsWith('/api/') || raw.startsWith('//')) return null;
  let url: URL;
  try {
    url = new URL(raw, 'http://link.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'http://link.invalid') return null;
  const path = `${url.pathname}${url.search}`;
  // The parser resolves `..`; what it resolved to is what is checked.
  if (!url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/dl')) return null;
  return path;
}

export interface DownloadGrant {
  userId: string;
  path: string;
}

/** A signed link token for `userId` to fetch `path` until `now + DOWNLOAD_TTL_MS`; null without a key or a linkable path. */
export function mintDownloadToken(userId: string, rawPath: string, now = Date.now()): string | null {
  const path = linkablePath(rawPath);
  if (!path || !userId) return null;
  const body = Buffer.from(JSON.stringify({ u: userId, p: path, e: now + DOWNLOAD_TTL_MS })).toString('base64url');
  const sig = mac('download-link', body);
  return sig ? `${body}.${sig}` : null;
}

export type DownloadRefusal = 'no_key' | 'malformed' | 'bad_signature' | 'expired';

/** The grant a token carries, or why it carries none. */
export function readDownloadToken(
  token: string,
  now = Date.now(),
): { ok: true; grant: DownloadGrant } | { ok: false; reason: DownloadRefusal } {
  if (!secret()) return { ok: false, reason: 'no_key' };
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return { ok: false, reason: 'malformed' };
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = mac('download-link', body);
  if (!expected || !same(sig, expected)) return { ok: false, reason: 'bad_signature' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const { u, p, e } = (parsed ?? {}) as { u?: unknown; p?: unknown; e?: unknown };
  const path = linkablePath(p);
  if (typeof u !== 'string' || !u || !path || typeof e !== 'number') return { ok: false, reason: 'malformed' };
  if (now > e) return { ok: false, reason: 'expired' };
  return { ok: true, grant: { userId: u, path } };
}

/**
 * The value of `INTERNAL_HEADER` on the link route's own request — derived,
 * never configured, and never sent outside the process: a request from the
 * world carrying the delegated-user header without it is a stranger's.
 */
export function internalKey(): string | null {
  return mac('internal-download', 'v1');
}

/** The user a request is delegated to by the link route, or null (the ordinary cookie path). */
export function delegatedUserId(headerValue: (name: string) => string | null): string | null {
  const userId = headerValue(DELEGATED_USER_HEADER);
  if (!userId) return null;
  const key = internalKey();
  const given = headerValue(INTERNAL_HEADER);
  if (!key || !given || !same(given, key)) return null;
  return userId;
}
