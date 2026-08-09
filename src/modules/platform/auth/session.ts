import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { cookies, headers } from 'next/headers';
import { db } from '../db/client';
import { sessions, users } from '../db/schema';

export const SESSION_COOKIE = 'gsr_session';
const SESSION_DAYS = 30;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The caller's address, as far as it can be trusted.
 *
 * `X-Forwarded-For` is a LIST and every hop appends to it, so the leftmost
 * entry is whatever the CLIENT chose to send — this used to read `[0]`, which
 * means an attacker rotating one header got a fresh identity on every request.
 * That is not a cosmetic bug: `isRateLimited` paired the identifier with this
 * value, so the five-tries-per-fifteen-minutes fence on the login form could
 * be walked around by anybody, and the address written into `sessions.ip` and
 * into every audit row was equally the attacker's choice.
 *
 * The RIGHTMOST entry is the one appended by the hop closest to us — our own
 * Caddy, on the internal docker network — so it is the only element in the
 * list nobody outside can dictate. If a CDN is ever put in front of Caddy this
 * has to become "the Nth from the right", counted by how many proxies we run.
 * No header at all means the caller reached the app without the proxy, and the
 * honest answer is «unknown» rather than a number nobody stands behind.
 */
export function trustedIpFrom(forwarded: string | null): string | null {
  if (!forwarded) return null;
  const hops = forwarded
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops.length > 0 ? (hops[hops.length - 1] ?? null) : null;
}

export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  return { ip: trustedIpFrom(h.get('x-forwarded-for')), userAgent: h.get('user-agent') };
}

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const { ip, userAgent } = await requestMeta();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    ip,
    userAgent,
    deviceLabel: deviceLabelFrom(userAgent),
    expiresAt,
  });
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

function deviceLabelFrom(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  if (/android/i.test(userAgent)) return 'Android';
  if (/iphone|ipad/i.test(userAgent)) return 'iOS';
  if (/windows/i.test(userAgent)) return 'Windows';
  if (/macintosh/i.test(userAgent)) return 'Mac';
  if (/linux/i.test(userAgent)) return 'Linux';
  return 'Unknown device';
}

export interface SessionUser {
  id: string;
  phone: string;
  username: string | null;
  fullName: string;
  locale: string;
  active: boolean;
  sessionId: string;
}

/** Resolve the current session user, sliding the expiry forward (30-day rolling). */
export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const now = new Date();
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        gt(sessions.expiresAt, now),
        isNull(sessions.revokedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row || !row.user.active) return null;

  // Slide expiry / last-seen at most once an hour to avoid a write per request.
  if (now.getTime() - row.session.lastSeenAt.getTime() > 60 * 60 * 1000) {
    await db
      .update(sessions)
      .set({
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000),
      })
      .where(eq(sessions.id, row.session.id));
  }

  return {
    id: row.user.id,
    phone: row.user.phone,
    username: row.user.username,
    fullName: row.user.fullName,
    locale: row.user.locale,
    active: row.user.active,
    sessionId: row.session.id,
  };
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.tokenHash, hashToken(token)));
  }
  cookieStore.delete(SESSION_COOKIE);
}

/** Revoke every other session of the user ("logout other devices", spec 4.1). */
export async function revokeOtherSessions(userId: string, keepSessionId: string): Promise<void> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  const toRevoke = rows.map((r) => r.id).filter((sid) => sid !== keepSessionId);
  for (const sid of toRevoke) {
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sid));
  }
}

export async function listSessions(userId: string) {
  return db
    .select({
      id: sessions.id,
      deviceLabel: sessions.deviceLabel,
      ip: sessions.ip,
      lastSeenAt: sessions.lastSeenAt,
      createdAt: sessions.createdAt,
      revokedAt: sessions.revokedAt,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}
