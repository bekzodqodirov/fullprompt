import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { permissions, rolePermissions, roles, userRoles, userWarehouses } from '../db/schema';
import { getSessionUser, type SessionUser } from '../auth/session';
import { WAREHOUSE_SCOPED_ROLES, type PermissionCode, type RoleCode } from './catalog';

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
  permissions: Set<string>;
  warehouseIds: string[];
  /** True when every role the user has is warehouse-scoped (spec 4.2). */
  warehouseScoped: boolean;
}

/** Load the current user with roles, permissions and warehouse assignments. */
export async function getActor(): Promise<Actor | null> {
  const user = await getSessionUser();
  if (!user) return null;

  const roleRows = await db
    .select({ code: roles.code })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, user.id));
  const roleCodes = roleRows.map((r) => r.code as RoleCode);

  const permRows = await db
    .select({ code: permissions.code })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(userRoles.userId, user.id));

  const whRows = await db
    .select({ warehouseId: userWarehouses.warehouseId })
    .from(userWarehouses)
    .where(eq(userWarehouses.userId, user.id));

  const warehouseScoped =
    roleCodes.length > 0 && roleCodes.every((rc) => WAREHOUSE_SCOPED_ROLES.includes(rc));

  return {
    ...user,
    roles: roleCodes,
    permissions: new Set(permRows.map((p) => p.code)),
    warehouseIds: whRows.map((w) => w.warehouseId),
    warehouseScoped,
  };
}

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
  if (opts.warehouseId && actor.warehouseScoped && !actor.warehouseIds.includes(opts.warehouseId)) {
    throw new AuthError('Warehouse out of scope', 'forbidden');
  }
  return actor;
}

export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new AuthError('Not authenticated', 'unauthenticated');
  return actor;
}
