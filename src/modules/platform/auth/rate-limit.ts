import { and, count, eq, gt } from 'drizzle-orm';
import { db } from '../db/client';
import { loginAttempts } from '../db/schema';

const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;

/**
 * Spec 4.1: 5 tries / 15 min / IP+account. Counts failed attempts for the
 * (identifier, ip) pair inside the window.
 */
export async function isRateLimited(identifier: string, ip: string): Promise<boolean> {
  const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000);
  const [row] = await db
    .select({ n: count() })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.identifier, identifier),
        eq(loginAttempts.ip, ip),
        eq(loginAttempts.success, false),
        gt(loginAttempts.createdAt, windowStart),
      ),
    );
  return (row?.n ?? 0) >= MAX_ATTEMPTS;
}

export async function recordLoginAttempt(
  identifier: string,
  ip: string,
  success: boolean,
): Promise<void> {
  await db.insert(loginAttempts).values({ identifier, ip, success });
}
