import { and, count, eq, gt } from 'drizzle-orm';
import { db } from '../db/client';
import { loginAttempts } from '../db/schema';

const MAX_ATTEMPTS = 5;
/** One address may be trying several accounts — spraying, not guessing. */
const MAX_PER_IP = 20;
const WINDOW_MINUTES = 15;

/**
 * Spec 4.1: 5 tries / 15 min. Counted on the ACCOUNT, and separately on the
 * address.
 *
 * It used to count the (identifier, ip) PAIR, which is the same as not
 * counting at all: the address came from `X-Forwarded-For`, the caller writes
 * that header, and a fresh value put every attempt in its own bucket. So one
 * staff password could be guessed without limit — on a system whose ~20 people
 * sign in with a phone number and a password, and whose session then lasts
 * thirty rolling days.
 *
 * The account count is the fence that matters and it cannot be escaped,
 * because the identifier is the thing being attacked. The address count is a
 * second, wider net for somebody trying one password across many accounts;
 * it is deliberately allowed to be defeated by a rotating header, since
 * nothing rests on it alone.
 *
 * The trade this makes, stated: five failures now lock ONE account for fifteen
 * minutes whoever caused them, so a person who knows a colleague's phone
 * number can be a nuisance. That is recoverable in fifteen minutes; an
 * unbounded password guess is not recoverable at all.
 */
export async function isRateLimited(identifier: string, ip: string): Promise<boolean> {
  const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000);
  const failed = and(eq(loginAttempts.success, false), gt(loginAttempts.createdAt, windowStart));

  const [byAccount] = await db
    .select({ n: count() })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.identifier, identifier), failed));
  if ((byAccount?.n ?? 0) >= MAX_ATTEMPTS) return true;

  const [byIp] = await db
    .select({ n: count() })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.ip, ip), failed));
  return (byIp?.n ?? 0) >= MAX_PER_IP;
}

export async function recordLoginAttempt(
  identifier: string,
  ip: string,
  success: boolean,
): Promise<void> {
  await db.insert(loginAttempts).values({ identifier, ip, success });
}
