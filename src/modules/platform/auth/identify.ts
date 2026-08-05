import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';

/**
 * Who is trying to log in.
 *
 * The login box takes a phone number OR a username, and both columns are
 * unique — but they are unique SEPARATELY, and the OR of two unique columns is
 * not unique: one row can match by phone while a different row matches by
 * username. Nothing forbids that state, because the only writer of `username`
 * accepts any string (a phone-shaped one included) and its duplicate check
 * looks at phones alone.
 *
 * The old read was `or(phone, username)` with `limit(1)` and no ORDER BY, so
 * the planner decided which of the two rows had its password checked. The path
 * is fail-closed — a session is only ever created for the row whose hash
 * validated — so the symptom would not have been somebody in the wrong
 * account, it would have been a colleague refused with the right password, at
 * random, with nothing on the screen or in the log to explain it.
 *
 * Two reads, and the precedence is a decision rather than the planner's:
 * **the phone wins**. Every account in this system is minted with a phone,
 * usernames are optional and no import has ever written one, so a collision
 * means somebody typed a colleague's number into a username box — and the
 * number is the identity the owner hands out.
 */
export async function findUserByIdentifier(identifier: string) {
  const [byPhone] = await db.select().from(users).where(eq(users.phone, identifier)).limit(1);
  if (byPhone) return byPhone;
  const [byUsername] = await db.select().from(users).where(eq(users.username, identifier)).limit(1);
  return byUsername;
}
