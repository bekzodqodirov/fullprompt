import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import { loginRowSql } from '../users/login';

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
 * **the phone wins**. Every LOGIN is minted with a phone
 * (`users_login_phone_check`), usernames are optional and no import has ever
 * written one, so a collision means somebody typed a colleague's number into a
 * username box — and the number is the identity the owner hands out.
 *
 * A no-login row (0120, the owner's 2b) is never an identity: its phone is
 * typed by the accountant, not handed out by the owner, and it must never
 * shadow a login's username — so BOTH reads ask `loginRowSql()`. Not
 * `canLogInSql()`: a DEACTIVATED login keeps its identity, so «the phone wins»
 * stays true for it exactly as before, and `loginAction` refuses it by
 * `canLogIn`.
 */
export async function findUserByIdentifier(identifier: string) {
  const [byPhone] = await db
    .select()
    .from(users)
    .where(and(eq(users.phone, identifier), loginRowSql()))
    .limit(1);
  if (byPhone) return byPhone;
  const [byUsername] = await db
    .select()
    .from(users)
    .where(and(eq(users.username, identifier), loginRowSql()))
    .limit(1);
  return byUsername;
}
