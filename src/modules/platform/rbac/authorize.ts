import { cache } from 'react';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { permissions, rolePermissions, roles, userRoles, userWarehouses } from '../db/schema';
import { getSessionUser, type SessionUser } from '../auth/session';
import type { PermissionCode, RoleCode } from './catalog';
import { inScope } from './scope';

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code: 'unauthenticated' | 'forbidden',
  ) {
    super(message);
  }
}

export interface Actor extends SessionUser {
  roles: RoleCode[];
  /** The UNION of the roles' editable grants — what nearly every door asks. */
  permissions: Set<string>;
  /**
   * Each role's OWN editable grants, by role code — `permissions` is their
   * union. For the rare rule that keys on what ONE role was given rather than
   * on what the person holds through any of them: the counter's debt tick
   * (wms/finance/scope.ts `counterDebtRelease`) asks whether the WAREHOUSE
   * MANAGER role carries `finance.debt_override`, because that untick on
   * /admin/roles is the owner's off switch, and a manager who is also a
   * seller holds the same grant through the seller's role. A role with no
   * grants has no entry. REQUIRED, so the compiler names every place that
   * builds an actor by hand.
   */
  roleGrants: ReadonlyMap<string, ReadonlySet<string>>;
  warehouseIds: string[];
  /** True when ANY role the user has is warehouse-scoped (spec 4.2). */
  warehouseScoped: boolean;
}

/**
 * Load the current user with roles, permissions and warehouse assignments.
 *
 * Memoised per request with React's `cache`: this is called from 70-odd
 * files — layout, page, every server action, several API routes — and each
 * call was three round-trips to Postgres. One dashboard render was doing the
 * same three queries a dozen times. `cache` keys on the arguments (there are
 * none) and is discarded when the request ends, so there is no cross-request
 * leak: two users cannot see each other's actor.
 */
/**
 * One user's roles with the scoping flag, exported so the rule "any scoped
 * role scopes the user" can be proved against real rows — including a role
 * that exists only as a database row, which is exactly the case the
 * compiled list used to get wrong.
 */
export async function loadUserRoles(
  userId: string,
): Promise<{ code: string; warehouseScoped: boolean }[]> {
  return db
    .select({ code: roles.code, warehouseScoped: roles.warehouseScoped })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId));
}

/**
 * One user's EDITABLE grants, role by role — the one home of the join from a
 * person to what each of their roles was given. ONE query: the role's code
 * rides the same rows as its permission codes, so the per-role answer costs
 * no second round trip. `userPermissions` (the union) and `actorGrants` (the
 * union AND the per-role map) both read it.
 */
export async function userRoleGrants(userId: string): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const rows = await db
    .select({ role: roles.code, code: permissions.code })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(userRoles.userId, userId));
  const byRole = new Map<string, Set<string>>();
  for (const row of rows) byRole.set(row.role, (byRole.get(row.role) ?? new Set()).add(row.code));
  return byRole;
}

/** Every code any of the roles carries — permissions union (widest wins, #199). */
export function grantsUnion(byRole: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const union = new Set<string>();
  for (const codes of byRole.values()) for (const code of codes) union.add(code);
  return union;
}

/**
 * One user's permission codes — the union of their roles' EDITABLE grants,
 * from the one join above. The staff bot's two grant-only doors
 * («Bajarildi», the debtor «Ruxsat») read it: they need the grants and none
 * of the scope.
 */
export async function userPermissions(userId: string): Promise<Set<string>> {
  return grantsUnion(await userRoleGrants(userId));
}

/** Everything an actor is besides who they are: the grants and the scope. */
export type ActorGrants = Pick<Actor, 'roles' | 'permissions' | 'roleGrants' | 'warehouseIds' | 'warehouseScoped'>;

/**
 * One user's roles, permissions (from the EDITABLE grants) and warehouse
 * scope — the three answers `getActor` gives a session, for a user named by
 * id. ONE «actor without a session»: the staff bot's `botActorFor` and the
 * owner's evening summary (a job, with no request at all) read it, so a read
 * made for them can never be wider than the screen's read for the same
 * person (#411's rule). The bot's grant-only doors read `userPermissions`,
 * the same join, with nothing wider.
 */
export async function actorGrants(userId: string): Promise<ActorGrants> {
  const roleRows = await loadUserRoles(userId);
  const roleCodes = roleRows.map((r) => r.code as RoleCode);

  // ONE read of the grants, role by role; the union is computed from it, so
  // `permissions` and `roleGrants` can never describe two different days.
  const granted = await userRoleGrants(userId);

  const whRows = await db
    .select({ warehouseId: userWarehouses.warehouseId })
    .from(userWarehouses)
    .where(eq(userWarehouses.userId, userId));

  // From the COLUMN, not the compiled role-name list (migration 0049): a
  // role invented on /admin/roles carries its own answer. ANY scoped role
  // scopes the user — permissions union (widest wins), scope intersects
  // (narrowest wins), the rule #199 established.
  const warehouseScoped = roleRows.some((r) => r.warehouseScoped);

  return {
    roles: roleCodes,
    permissions: grantsUnion(granted),
    roleGrants: granted,
    warehouseIds: whRows.map((w) => w.warehouseId),
    warehouseScoped,
  };
}

export const getActor = cache(async function getActor(): Promise<Actor | null> {
  const user = await getSessionUser();
  if (!user) return null;
  return { ...user, ...(await actorGrants(user.id)) };
});

/**
 * The single server-side authz gate (spec 4.2): every mutation and protected
 * read goes through this. Throws AuthError on failure.
 *
 * `warehouseId` — pass when the action targets a specific warehouse; users
 * whose roles are all warehouse-scoped must have it assigned.
 */
export async function authorize(
  permission: PermissionCode,
  opts: { warehouseId?: string } = {},
): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new AuthError('Not authenticated', 'unauthenticated');
  if (!actor.permissions.has(permission)) {
    throw new AuthError(`Missing permission ${permission}`, 'forbidden');
  }
  // `inScope` — the pure predicate `mayAt` asks too, so the gate and the
  // per-warehouse decision the phone's sync makes cannot drift apart.
  if (opts.warehouseId && !inScope(actor, opts.warehouseId)) {
    throw new AuthError('Warehouse out of scope', 'forbidden');
  }
  return actor;
}

export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new AuthError('Not authenticated', 'unauthenticated');
  return actor;
}
