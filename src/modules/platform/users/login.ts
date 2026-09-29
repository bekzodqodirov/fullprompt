import { sql, type SQL } from 'drizzle-orm';
import { users } from '../db/schema';

/**
 * WHO IS A COLLEAGUE — the one home of the rule (0120, the owner's 2b: people
 * who are paid here and never sign in, such as the workers in the Chinese
 * warehouses).
 *
 * Such a person is an ordinary `users` row with `login_enabled = false`, so
 * every place that once asked «is this user active» to mean «may I pick,
 * notify, route to or authenticate this person» now asks `canLogIn` instead:
 * active AND a login. Reading `users.active` alone is a person the salary
 * page wants and nobody else does; `tests/unit/login-person-fence.test.ts`
 * holds every `.active` reference in `src/` to this file, the writer's
 * module and a named payroll allowlist.
 *
 * Pure: no `db`, so it is safe inside a transaction, in a unit test and in
 * tx-pool's follow-the-call.
 */

/** The row is a login (past or present, active or not) — `login_enabled`, one column read in one place. */
export function loginRowSql(): SQL<boolean> {
  return sql<boolean>`${users.loginEnabled}`;
}

/**
 * Somebody the system treats as a colleague NOW — active AND a login. Asked by
 * every site that picks, tells, routes to or authenticates a person. A raw
 * query that aliases `users` passes the alias (`FROM users u` → 'u'), because
 * `${users.active}` renders "users"."active", which postgres refuses against
 * an alias.
 */
export function canLogInSql(alias?: string): SQL<boolean> {
  if (alias) {
    const a = sql.identifier(alias);
    return sql<boolean>`(${a}.active AND ${a}.login_enabled)`;
  }
  return sql<boolean>`(${users.active} AND ${loginRowSql()})`;
}

/** The same rule over a row already in hand. */
export function canLogIn(u: { active: boolean; loginEnabled: boolean }): boolean {
  return u.active && u.loginEnabled;
}

/**
 * The cabinet's phone rule, restated here because platform must never import
 * wms: digits only, compare the last 9 — "+998 90…" and "90…" are the same
 * person, and anything under 7 digits is too short to trust.
 *
 * MOVED from telegram/staff-bot.ts (which re-exports it) so the conversion
 * door (users/service.ts `enableLogin`) can ask the bot's own rule without
 * importing the bot: a login's phone is what the staff bot binds a Telegram
 * contact to, so two logins whose numbers agree on the last nine digits would
 * bind to whichever row the bot met first.
 */
export function staffPhonesMatch(a: string, b: string): boolean {
  const da = a.replace(/\D/g, '');
  const db2 = b.replace(/\D/g, '');
  if (da.length < 7 || db2.length < 7) return false;
  const n = Math.min(9, da.length, db2.length);
  return da.slice(-n) === db2.slice(-n);
}

/**
 * A no-login person's phone (2b): trimmed; spaces, dashes, dots and
 * parentheses dropped; then an optional leading + and 7–15 digits, or
 * refused. '' = no phone. A phone-shaped value can never collide with a
 * username like «bekzod», so a payroll phone can never shadow a login name
 * in the login box (the service also refuses one equal to a username).
 */
export function noLoginPhone(raw: string): { ok: true; phone: string | null } | { ok: false } {
  const cleaned = raw.trim().replace(/[\s\-.()]/g, '');
  if (cleaned === '') return { ok: true, phone: null };
  return /^\+?\d{7,15}$/.test(cleaned) ? { ok: true, phone: cleaned } : { ok: false };
}
