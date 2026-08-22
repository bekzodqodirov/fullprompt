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
  return (await addressBlocked(ip)) || (await accountLocked(identifier));
}

/**
 * The wide net, and the one that must be asked BEFORE the password is
 * verified: argon2 is deliberately expensive, and this app is a single Node
 * process, so an unauthenticated flood of guesses is a CPU denial of service
 * whatever it does to any one account.
 */
export async function addressBlocked(ip: string): Promise<boolean> {
  const [byIp] = await db
    .select({ n: count() })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.ip, ip), failedRecently()));
  return (byIp?.n ?? 0) >= MAX_PER_IP;
}

/**
 * The account fence, asked only AFTER a password has failed to validate.
 *
 * The order is the whole fix (found by the pre-go-live audit): asked FIRST,
 * as it was, five wrong guesses locked the account against its own owner
 * typing the right password — so anyone who knows a colleague's phone number
 * could hold them out of a fresh login for fifteen minutes at a time, and
 * staff phones are guessable. Asked after the check, a correct password is
 * never refused, while a wrong one still counts and still caps: the
 * unbounded guess round 81 closed stays closed, because every failure is
 * recorded before this is consulted.
 */
export async function accountLocked(identifier: string): Promise<boolean> {
  const [byAccount] = await db
    .select({ n: count() })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.identifier, identifier), failedRecently()));
  return (byAccount?.n ?? 0) >= MAX_ATTEMPTS;
}

function failedRecently() {
  const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000);
  return and(eq(loginAttempts.success, false), gt(loginAttempts.createdAt, windowStart));
}

export async function recordLoginAttempt(
  identifier: string,
  ip: string,
  success: boolean,
): Promise<void> {
  await db.insert(loginAttempts).values({ identifier, ip, success });
}
