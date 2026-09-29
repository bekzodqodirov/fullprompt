import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client';
import { roles, userRoles, users, userWarehouses } from '../db/schema';
import { diffFields, writeAudit, type AuditContext } from '../audit/service';
import { canLogInSql, noLoginPhone, staffPhonesMatch } from './login';

/**
 * THE writer of a person (0120, the owner's 2b).
 *
 * One module writes `users.active`, `users.login_enabled`,
 * `users.password_hash`, `users.phone`, inserts `users`, and is the only
 * writer of `user_roles` / `user_warehouses` — so the two rules that decide
 * what a person may become live in one place instead of in two actions in two
 * shapes:
 *
 *   - a person who never signs in holds NO role and NO warehouse. A role is
 *     what puts somebody in every role-keyed list (salesManagerOptions,
 *     usersWithPermission, the VED pool…), so a role on such a row would make
 *     a worker in China a seller the moment somebody ticked a box;
 *   - adding or removing super_admin is a super_admin's move (the annul
 *     round's C10), asked by create, update and the conversion alike.
 *
 * Every multi-step write is ONE transaction, and nothing inside it touches the
 * pool (#714): every read before a transaction runs on `db` OUTSIDE it, and
 * the argon2 hash is computed by the caller before any of it.
 *
 * Login → no-login has no writer at all: `loginEnabled: false` is written by
 * `mintNoLoginPerson` alone, and deactivation is a leaver's only exit.
 * `tests/unit/login-person-fence.test.ts` holds all of it.
 */

export type UserWriteRefusal =
  | 'name_required'
  | 'bad_phone'
  | 'phone_exists'
  | 'username_exists'
  | 'same_name'
  | 'not_found'
  | 'is_login'
  | 'already_login'
  | 'no_login_row'
  | 'inactive_person'
  | 'super_admin_locked';

export interface SameNameMatch {
  id: string;
  name: string;
  active: boolean;
  loginEnabled: boolean;
}

export class UserWriteError extends Error {
  constructor(
    readonly code: UserWriteRefusal,
    /** `same_name` only: who is already listed under the name (≤ 5) and how many in all. */
    readonly same?: { matches: SameNameMatch[]; total: number },
  ) {
    super(code);
    this.name = 'UserWriteError';
  }
}

type Locale = 'ru' | 'uz' | 'zh-CN' | 'en';

/**
 * The unique index answered a race the pre-check lost — the same sentence as
 * the pre-check, never a white page (#472). Anything else is not ours to name.
 */
function uniqueRefusal(err: unknown): UserWriteError | null {
  type PgError = { code?: string; constraint_name?: string };
  const pg = err as PgError & { cause?: PgError };
  const code = pg?.code ?? pg?.cause?.code;
  const constraint = pg?.constraint_name ?? pg?.cause?.constraint_name;
  if (code !== '23505') return null;
  if (constraint === 'users_phone_unique') return new UserWriteError('phone_exists');
  if (constraint === 'users_username_unique') return new UserWriteError('username_exists');
  return null;
}

async function mapUnique<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const refusal = uniqueRefusal(err);
    if (refusal) throw refusal;
    throw err;
  }
}

/** Trimmed, inner whitespace collapsed — the one shape a person's name is stored and compared in. */
function personName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ');
  return name.length >= 1 && name.length <= 200 ? name : null;
}

/**
 * Who is already listed under this name — every row, logins and leavers
 * included, because the commonest duplicate is a person the accountant cannot
 * see on the salary page any more. The name NAMES them (the quick-create rule):
 * «shu ism bor» with no names is a refusal nobody can act on.
 */
async function sameNameMatches(name: string): Promise<{ matches: SameNameMatch[]; total: number }> {
  const rows = await db
    .select({
      id: users.id,
      name: users.fullName,
      active: users.active,
      loginEnabled: users.loginEnabled,
      total: sql<string>`count(*) OVER ()`,
    })
    .from(users)
    .where(sql`lower(regexp_replace(btrim(${users.fullName}), '\\s+', ' ', 'g')) = lower(${name})`)
    .orderBy(desc(users.active), desc(users.loginEnabled), asc(users.fullName))
    .limit(5);
  return {
    matches: rows.map((r) => ({ id: r.id, name: r.name, active: r.active, loginEnabled: r.loginEnabled })),
    total: rows.length ? Number(rows[0]!.total) : 0,
  };
}

/** A phone some other row already holds — as its phone, or as its USERNAME (the login box reads both). */
async function phoneTaken(phone: string, exceptId?: string): Promise<boolean> {
  const [hit] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        or(eq(users.phone, phone), eq(users.username, phone)),
        exceptId ? ne(users.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return Boolean(hit);
}

/** Mint a person who never signs in. Writes NO roles and NO warehouses. */
export async function mintNoLoginPerson(
  input: { fullName: string; phone: string; confirmSameName: boolean },
  ctx: AuditContext,
): Promise<{ id: string }> {
  const name = personName(input.fullName);
  if (!name) throw new UserWriteError('name_required');
  const phoned = noLoginPhone(input.phone);
  if (!phoned.ok) throw new UserWriteError('bad_phone');
  const phone = phoned.phone;

  if (!input.confirmSameName) {
    const same = await sameNameMatches(name);
    if (same.total > 0) throw new UserWriteError('same_name', same);
  }
  if (phone && (await phoneTaken(phone))) throw new UserWriteError('phone_exists');

  return mapUnique(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({ fullName: name, phone, passwordHash: null, loginEnabled: false, username: null })
        .returning({ id: users.id });
      if (!row) throw new Error('mintNoLoginPerson: insert returned nothing');
      await writeAudit(tx, ctx, {
        entityType: 'user',
        entityId: row.id,
        action: 'create',
        after: { fullName: name, phone, loginEnabled: false },
      });
      return { id: row.id };
    }),
  );
}

/** Rename / re-phone a no-login person. A login row is refused (`is_login`) — that is /admin/users' job. */
export async function editNoLoginPerson(
  id: string,
  input: { fullName: string; phone: string },
  ctx: AuditContext,
): Promise<void> {
  const name = personName(input.fullName);
  if (!name) throw new UserWriteError('name_required');
  const phoned = noLoginPhone(input.phone);
  if (!phoned.ok) throw new UserWriteError('bad_phone');
  const phone = phoned.phone;
  // No same-name check: a rename is not a new person.
  if (phone && (await phoneTaken(phone, id))) throw new UserWriteError('phone_exists');

  await mapUnique(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({ fullName: users.fullName, phone: users.phone, loginEnabled: users.loginEnabled })
        .from(users)
        .where(eq(users.id, id))
        .for('update');
      if (!row) throw new UserWriteError('not_found');
      if (row.loginEnabled) throw new UserWriteError('is_login');
      await tx.update(users).set({ fullName: name, phone }).where(eq(users.id, id));
      const diff = diffFields({ fullName: row.fullName, phone: row.phone }, { fullName: name, phone });
      if (diff) await writeAudit(tx, ctx, { entityType: 'user', entityId: id, action: 'update', ...diff });
    }),
  );
}

/** «Ishdan ketdi» / «Qayta faollashtirish» on a no-login person. Login rows → `is_login`. */
export async function setNoLoginPersonActive(id: string, active: boolean, ctx: AuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ active: users.active, loginEnabled: users.loginEnabled })
      .from(users)
      .where(eq(users.id, id))
      .for('update');
    if (!row) throw new UserWriteError('not_found');
    if (row.loginEnabled) throw new UserWriteError('is_login');
    if (row.active === active) return;
    await flipActive(tx, id, row.active, active, ctx);
  });
}

/** /admin/users' «Faolsizlantirish / Faollashtirish» — any row, never yourself. */
export async function toggleUserActive(id: string, actorId: string, ctx: AuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ active: users.active }).from(users).where(eq(users.id, id)).for('update');
    if (!row) throw new UserWriteError('not_found');
    if (id === actorId) return;
    await flipActive(tx, id, row.active, !row.active, ctx);
  });
}

/** The one flip of `users.active`. Private: nothing outside this file can flip a person. */
async function flipActive(tx: Tx, id: string, before: boolean, after: boolean, ctx: AuditContext): Promise<void> {
  await tx.update(users).set({ active: after }).where(eq(users.id, id));
  await writeAudit(tx, ctx, {
    entityType: 'user',
    entityId: id,
    action: 'update',
    before: { active: before },
    after: { active: after },
  });
}

/**
 * THE writer of user_roles and user_warehouses, and the ONE home of two rules:
 * a no-login row holds no role (a role is what puts a person in every
 * role-keyed list — salesManagerOptions, usersWithPermission, the VED pool…),
 * and adding or removing super_admin is a super_admin's move (the annul
 * round's C10, until now copied into two actions in two shapes).
 * Takes the TRANSACTION only: every caller writes the users row in the same one.
 */
async function setRolesAndWarehouses(
  tx: Tx,
  userId: string,
  roleIds: string[],
  warehouseIds: string[],
  actorRoles: readonly string[],
): Promise<{ before: { roles: string[]; warehouses: string[] }; after: { roles: string[]; warehouses: string[] } }> {
  const [person] = await tx.select({ loginEnabled: users.loginEnabled }).from(users).where(eq(users.id, userId));
  if (!person) throw new UserWriteError('not_found');
  if (!person.loginEnabled) throw new UserWriteError('no_login_row');
  // The doors' zod demands one; unreachable from a door, a programming error otherwise.
  if (roleIds.length === 0) throw new Error('a login holds at least one role');

  const beforeRoles = (
    await tx
      .select({ code: roles.code })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, userId))
  )
    .map((r) => r.code)
    .sort();
  const beforeWarehouses = (
    await tx
      .select({ warehouseId: userWarehouses.warehouseId })
      .from(userWarehouses)
      .where(eq(userWarehouses.userId, userId))
  )
    .map((w) => w.warehouseId)
    .sort();
  const wantIds = [...new Set(roleIds)];
  const want = (await tx.select({ code: roles.code }).from(roles).where(inArray(roles.id, wantIds)))
    .map((r) => r.code)
    .sort();

  // Granting it is self-escalation one form post away; removing it is locking
  // the owner out with the same post.
  if (beforeRoles.includes('super_admin') !== want.includes('super_admin') && !actorRoles.includes('super_admin')) {
    throw new UserWriteError('super_admin_locked');
  }

  const wantWarehouses = [...new Set(warehouseIds)];
  await tx.delete(userRoles).where(eq(userRoles.userId, userId));
  await tx.insert(userRoles).values(wantIds.map((roleId) => ({ userId, roleId })));
  await tx.delete(userWarehouses).where(eq(userWarehouses.userId, userId));
  if (wantWarehouses.length) {
    await tx.insert(userWarehouses).values(wantWarehouses.map((warehouseId) => ({ userId, warehouseId })));
  }
  return {
    before: { roles: beforeRoles, warehouses: beforeWarehouses },
    after: { roles: want, warehouses: [...wantWarehouses].sort() },
  };
}

export interface LoginInput {
  fullName: string;
  phone: string;
  username: string | null;
  locale: Locale;
  roleIds: string[];
  warehouseIds: string[];
}

/** A new login (/admin/users/new). A refused super_admin rolls the user row back with it. */
export async function createLogin(
  input: LoginInput & { passwordHash: string },
  actorRoles: readonly string[],
  ctx: AuditContext,
): Promise<{ id: string }> {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.phone, input.phone)).limit(1);
  if (existing) throw new UserWriteError('phone_exists');

  return mapUnique(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({
          fullName: input.fullName,
          phone: input.phone,
          username: input.username,
          locale: input.locale,
          passwordHash: input.passwordHash,
        })
        .returning({ id: users.id });
      if (!row) throw new Error('createLogin: insert returned nothing');
      const { after } = await setRolesAndWarehouses(tx, row.id, input.roleIds, input.warehouseIds, actorRoles);
      await writeAudit(tx, ctx, {
        entityType: 'user',
        entityId: row.id,
        action: 'create',
        after: {
          fullName: input.fullName,
          phone: input.phone,
          username: input.username,
          locale: input.locale,
          roles: after.roles,
          warehouses: after.warehouses,
        },
      });
      return { id: row.id };
    }),
  );
}

/** Edit a login (/admin/users/[id]). `passwordHash` null = the password is unchanged. */
export async function updateLogin(
  id: string,
  input: LoginInput & { passwordHash: string | null },
  actorRoles: readonly string[],
  ctx: AuditContext,
): Promise<void> {
  const [duplicate] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.phone, input.phone), ne(users.id, id)))
    .limit(1);
  if (duplicate) throw new UserWriteError('phone_exists');

  await mapUnique(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({ fullName: users.fullName, phone: users.phone, username: users.username, locale: users.locale })
        .from(users)
        .where(eq(users.id, id))
        .for('update');
      if (!row) throw new UserWriteError('not_found');
      // The roles FIRST: they refuse a no-login row (and a super_admin change)
      // before anything is written — the users UPDATE below would otherwise
      // meet `users_login_username_check` on a no-login row carrying a posted
      // username, a 23514 white page instead of a sentence.
      const { before, after } = await setRolesAndWarehouses(tx, id, input.roleIds, input.warehouseIds, actorRoles);
      await tx
        .update(users)
        .set({
          fullName: input.fullName,
          phone: input.phone,
          username: input.username,
          locale: input.locale,
          ...(input.passwordHash ? { passwordHash: input.passwordHash } : {}),
        })
        .where(eq(users.id, id));
      const diff = diffFields(
        {
          fullName: row.fullName,
          phone: row.phone,
          username: row.username,
          locale: row.locale,
          roles: before.roles,
          warehouses: before.warehouses,
          password: null,
        },
        {
          fullName: input.fullName,
          phone: input.phone,
          username: input.username,
          locale: input.locale,
          roles: after.roles,
          warehouses: after.warehouses,
          password: input.passwordHash ? '(changed)' : null,
        },
      );
      if (diff) await writeAudit(tx, ctx, { entityType: 'user', entityId: id, action: 'update', ...diff });
    }),
  );
}

/**
 * The ONE door from «tizimga kirmaydi» to a login (/admin/users/[id]).
 *
 * The claim and the roles in ONE transaction. The hash is computed by the
 * caller BEFORE (argon2 is slow; never inside a transaction holding a row).
 * The name is not an input: it is shown read-only and renamed on /hodimlar
 * before, or on the ordinary edit form after.
 *
 * The phone is typed AFRESH and never inherited from the payroll row: the
 * accountant's number may be a shared warehouse phone, and a login's phone is
 * what the staff bot binds a Telegram contact to — so it is also refused when
 * its last nine digits match another colleague's (the bot's own rule).
 */
export async function enableLogin(
  id: string,
  input: {
    phone: string;
    username: string | null;
    locale: Locale;
    passwordHash: string;
    roleIds: string[];
    warehouseIds: string[];
  },
  actorRoles: readonly string[],
  ctx: AuditContext,
): Promise<void> {
  const phone = input.phone.trim();
  if (phone.length < 5 || phone.length > 30) throw new UserWriteError('bad_phone');

  const [exact] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.phone, phone), ne(users.id, id)))
    .limit(1);
  if (exact) throw new UserWriteError('phone_exists');
  const colleagues = await db
    .select({ phone: users.phone })
    .from(users)
    .where(and(canLogInSql(), ne(users.id, id)));
  if (colleagues.some((r) => r.phone !== null && staffPhonesMatch(phone, r.phone))) {
    throw new UserWriteError('phone_exists');
  }
  if (input.username) {
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.username, input.username), ne(users.id, id)))
      .limit(1);
    if (taken) throw new UserWriteError('username_exists');
  }

  await mapUnique(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          phone: users.phone,
          username: users.username,
          locale: users.locale,
          loginEnabled: users.loginEnabled,
          active: users.active,
        })
        .from(users)
        .where(eq(users.id, id))
        .for('update');
      if (!row) throw new UserWriteError('not_found');
      if (row.loginEnabled) throw new UserWriteError('already_login');
      if (!row.active) throw new UserWriteError('inactive_person');
      await tx
        .update(users)
        .set({
          phone,
          username: input.username,
          locale: input.locale,
          passwordHash: input.passwordHash,
          loginEnabled: true,
        })
        .where(eq(users.id, id));
      const { before, after } = await setRolesAndWarehouses(tx, id, input.roleIds, input.warehouseIds, actorRoles);
      // The REAL before-values: the payroll phone the accountant typed stays in
      // the record of what this press replaced.
      const diff = diffFields(
        {
          phone: row.phone,
          username: row.username,
          locale: row.locale,
          loginEnabled: row.loginEnabled,
          roles: before.roles,
          warehouses: before.warehouses,
          password: null,
        },
        {
          phone,
          username: input.username,
          locale: input.locale,
          loginEnabled: true,
          roles: after.roles,
          warehouses: after.warehouses,
          password: '(set)',
        },
      );
      if (diff) await writeAudit(tx, ctx, { entityType: 'user', entityId: id, action: 'update', ...diff });
    }),
  );
}

/** The active no-login people — /admin/users/new's «do not mint, convert» list. */
export async function activeNoLoginPeople(): Promise<{ id: string; fullName: string }[]> {
  return db
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .where(and(eq(users.loginEnabled, false), eq(users.active, true)))
    .orderBy(asc(users.fullName));
}
