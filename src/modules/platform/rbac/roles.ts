import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Db, type Tx } from '../db/client';
import { permissions, rolePermissions, roles, userRoles, users } from '../db/schema';
import { writeAudit, type AuditContext } from '../audit/service';
import { PERMISSION_CODES } from './catalog';

/**
 * Roles as data the owner edits (owner: "rol konstruktori", "hech narsa
 * hard-coded bo'lmasin").
 *
 * `ROLE_MATRIX` in catalog.ts was the only source of grants and `seed.ts` the
 * only writer — insert-only — so nobody could add a permission to a role,
 * take one away, or invent a role without a deploy.
 *
 * The guardrails here are the whole point. A permissions screen that can lock
 * the owner out of his own system, or let a manager quietly grant himself the
 * accounts, is worse than no screen: every rule below exists because the
 * alternative is a company with no way back in.
 */

export class RoleError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export const roleSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, 'lowercase_snake_case'),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional().or(z.literal('')),
});

export interface RoleView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  grantsCustomised: boolean;
  warehouseScoped: boolean;
  userCount: number;
  grants: string[];
}

/** Every role with its grants and how many people hold it. */
export async function listRoles(): Promise<RoleView[]> {
  const rows = await db
    .select({
      id: roles.id,
      code: roles.code,
      name: roles.name,
      description: roles.description,
      isSystem: roles.isSystem,
      grantsCustomised: roles.grantsCustomised,
      warehouseScoped: roles.warehouseScoped,
      userCount: sql<number>`(SELECT count(*) FROM user_roles ur WHERE ur.role_id = ${roles}.id)`,
    })
    .from(roles)
    .orderBy(asc(roles.code));

  const grantRows = await db
    .select({ roleId: rolePermissions.roleId, code: permissions.code })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id));
  const byRole = new Map<string, string[]>();
  for (const row of grantRows) {
    byRole.set(row.roleId, [...(byRole.get(row.roleId) ?? []), row.code]);
  }

  return rows.map((row) => ({
    ...row,
    userCount: Number(row.userCount),
    grants: (byRole.get(row.id) ?? []).sort(),
  }));
}

/**
 * The grants an editor is allowed to hand out.
 *
 * You cannot grant what you do not hold. Without this rule any holder of
 * `platform.roles.manage` is effectively a super admin — they would simply
 * tick every box on a role and assign it to themselves.
 */
export function grantableBy(actorPermissions: Set<string>): string[] {
  return PERMISSION_CODES.filter((code) => actorPermissions.has(code));
}

interface Editor {
  id: string;
  permissions: Set<string>;
  roles: string[];
}

async function loadRole(roleId: string) {
  const role = await db.query.roles.findFirst({ where: eq(roles.id, roleId) });
  if (!role) throw new RoleError('not_found');
  return role;
}

/**
 * Replace a role's grants.
 *
 * Refuses, in this order:
 *  - a role the editor currently holds — editing your own powers is how you
 *    lock yourself out, and how you quietly promote yourself;
 *  - a permission the editor does not hold;
 *  - stripping the last role that can manage roles, which would leave nobody
 *    able to fix it.
 */
export async function setRoleGrants(
  roleId: string,
  codes: string[],
  editor: Editor,
  ctx: AuditContext,
): Promise<void> {
  const role = await loadRole(roleId);
  if (editor.roles.includes(role.code)) throw new RoleError('own_role');

  const wanted = [...new Set(codes)];
  const unknown = wanted.filter((code) => !(PERMISSION_CODES as readonly string[]).includes(code));
  if (unknown.length) throw new RoleError('unknown_permission');

  const allowed = new Set(grantableBy(editor.permissions));
  const before = await roleGrantCodes(roleId);
  // Only the DIFFERENCE has to be grantable. Otherwise an editor who lacks
  // one permission a role already holds could never touch that role at all,
  // and would be tempted to delete and recreate it instead.
  const changed = [
    ...wanted.filter((code) => !before.includes(code)),
    ...before.filter((code) => !wanted.includes(code)),
  ];
  const forbidden = changed.filter((code) => !allowed.has(code));
  if (forbidden.length) throw new RoleError('not_grantable');

  await db.transaction(async (tx) => {
    // The system must keep at least one role that can manage roles, held by
    // at least one active person. Checked INSIDE the transaction against the
    // state this write is about to create.
    const permRows = await tx
      .select({ id: permissions.id, code: permissions.code })
      .from(permissions);
    const permId = new Map(permRows.map((row) => [row.code, row.id] as const));

    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    if (wanted.length) {
      await tx.insert(rolePermissions).values(
        wanted.map((code) => ({
          roleId,
          permissionId: permId.get(code)!,
          source: 'admin' as const,
        })),
      );
    }
    await tx.update(roles).set({ grantsCustomised: true }).where(eq(roles.id, roleId));

    if (!(await someoneCanStillManageRoles(tx))) throw new RoleError('last_admin');
  });

  await writeAudit(db, ctx, {
    entityType: 'role',
    entityId: roleId,
    action: 'update',
    before: { grants: before },
    after: { grants: wanted.sort() },
  });
}

async function roleGrantCodes(roleId: string): Promise<string[]> {
  const rows = await db
    .select({ code: permissions.code })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(rolePermissions.roleId, roleId));
  return rows.map((row) => row.code).sort();
}

/**
 * Is there still an ACTIVE person who can reach this screen at all?
 *
 * Exported so it can be tested against a database state that genuinely has
 * nobody left — a state no test may commit, because it is the one condition
 * this whole module exists to prevent.
 */
export async function someoneCanStillManageRoles(tx: Db | Tx): Promise<boolean> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(userRoles)
    .innerJoin(users, eq(userRoles.userId, users.id))
    .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(and(eq(users.active, true), eq(permissions.code, 'platform.roles.manage')));
  return Number(row?.n ?? 0) > 0;
}

/** A role the owner invents. Starts with nothing and is never a system role. */
export async function createRole(
  input: z.infer<typeof roleSchema>,
  editor: Editor,
  ctx: AuditContext,
) {
  const existing = await db.query.roles.findFirst({ where: eq(roles.code, input.code) });
  if (existing) throw new RoleError('code_exists');

  const [row] = await db
    .insert(roles)
    .values({
      code: input.code,
      name: input.name,
      description: input.description || null,
      isSystem: false,
      // A brand-new role has no grants to protect, but marking it customised
      // now stops the seed ever adopting a code it happens to ship later.
      grantsCustomised: true,
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'role',
    entityId: row!.id,
    action: 'create',
    after: { code: input.code, name: input.name, by: editor.id },
  });
  return row!;
}

/**
 * Tie (or untie) a role's grants to the holder's assigned warehouses.
 *
 * The rule an invented warehouse role was missing (migration 0049). Same
 * own-role guard as grants: UNTICKING the flag on a role you hold widens
 * your own reach over every warehouse in the company — the exact
 * self-promotion the grants editor refuses. Audited both ways.
 */
export async function setRoleScoped(
  roleId: string,
  scoped: boolean,
  editor: Editor,
  ctx: AuditContext,
): Promise<void> {
  const role = await loadRole(roleId);
  if (editor.roles.includes(role.code)) throw new RoleError('own_role');
  if (role.warehouseScoped === scoped) return;
  await db.update(roles).set({ warehouseScoped: scoped }).where(eq(roles.id, roleId));
  await writeAudit(db, ctx, {
    entityType: 'role',
    entityId: roleId,
    action: 'update',
    before: { warehouseScoped: role.warehouseScoped },
    after: { warehouseScoped: scoped },
  });
}

export async function renameRole(
  roleId: string,
  name: string,
  description: string,
  ctx: AuditContext,
): Promise<void> {
  const role = await loadRole(roleId);
  const trimmed = name.trim();
  if (trimmed.length < 1) throw new RoleError('name_required');
  await db
    .update(roles)
    .set({ name: trimmed, description: description.trim() || null })
    .where(eq(roles.id, roleId));
  await writeAudit(db, ctx, {
    entityType: 'role',
    entityId: roleId,
    action: 'update',
    before: { name: role.name, description: role.description },
    after: { name: trimmed, description: description.trim() || null },
  });
}

/**
 * Delete a role the owner invented.
 *
 * A system role never goes — the code references those nine by name. A role
 * somebody holds never goes either: deleting it would silently strip that
 * person's access with no record of what they used to have.
 */
export async function deleteRole(roleId: string, ctx: AuditContext): Promise<void> {
  const role = await loadRole(roleId);
  if (role.isSystem) throw new RoleError('system_role');
  const [holders] = await db
    .select({ n: sql<number>`count(*)` })
    .from(userRoles)
    .where(eq(userRoles.roleId, roleId));
  if (Number(holders?.n ?? 0) > 0) throw new RoleError('role_in_use');

  await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
  await db.delete(roles).where(eq(roles.id, roleId));
  await writeAudit(db, ctx, {
    entityType: 'role',
    entityId: roleId,
    action: 'delete',
    before: { code: role.code, name: role.name },
  });
}

/**
 * Permission codes grouped for the screen.
 *
 * Thirty-eight checkboxes in one column is not a thing anyone can reason
 * about; grouped by the area they govern, it is. The grouping is derived from
 * the code prefix, so a new permission appears in the right place without
 * anyone maintaining a second list.
 */
export function groupPermissions(codes: readonly string[]): { area: string; codes: string[] }[] {
  const byArea = new Map<string, string[]>();
  for (const code of codes) {
    const area = code.split('.')[0]!;
    byArea.set(area, [...(byArea.get(area) ?? []), code]);
  }
  return [...byArea.entries()]
    .map(([area, list]) => ({ area, codes: list.sort() }))
    .sort((a, b) => a.area.localeCompare(b.area));
}

/** Roles a person may be given, for the user form. */
export async function assignableRoles(): Promise<{ id: string; code: string; name: string }[]> {
  return db
    .select({ id: roles.id, code: roles.code, name: roles.name })
    .from(roles)
    .orderBy(asc(roles.code));
}

/** Ensure every catalogued permission exists as a row (called by the seed). */
export async function syncPermissionRows(): Promise<void> {
  const existing = new Set(
    (await db.select({ code: permissions.code }).from(permissions)).map((row) => row.code),
  );
  const missing = PERMISSION_CODES.filter((code) => !existing.has(code));
  if (missing.length) {
    await db.insert(permissions).values(missing.map((code) => ({ code })));
  }
  // A code removed from the catalogue is left in place on purpose: it may
  // still be granted somewhere, and deleting the row cascades that grant away
  // without a trace.
}
