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

export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for');
  const ip = forwarded ? (forwarded.split(',')[0]?.trim() ?? null) : null;
  return { ip, userAgent: h.get('user-agent') };
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
