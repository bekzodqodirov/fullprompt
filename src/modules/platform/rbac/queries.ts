import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { permissions, rolePermissions, roles, userRoles, users } from '../db/schema';

/**
 * Who may be a client's or a lead's owner.
 *
 * This used to be `roles.code = 'sales_manager'` and that single line deleted
 * live data: the dropdown it fills is a bare `<select>` whose first option is
 * blank, so for every client whose owner is NOT carrying that exact role — the
 * owner himself, the logist, anyone on a role invented in `/admin/roles` — the
 * browser silently selected the blank option, and pressing Save for any
 * unrelated reason (a phone typo) wrote NULL over the assignment. On the
 * owner's own data that was 168 of the 262 assigned clients.
 *
 * So the question is answered by a PERMISSION rather than a role name — the
 * same lesson as DECISIONS #166 and the reason the role editor exists at all:
 * a role the owner invents tomorrow must be able to hold clients without
 * anybody editing this file.
 *
 * `include` re-adds the person currently assigned even if they no longer
 * qualify (they changed jobs, they were deactivated). A value the form cannot
 * RENDER is a value the form will DELETE — the general rule this codebase
 * already wrote down once for checkboxes (DECISIONS #171).
 */
const OWNER_PERMISSIONS = ['crm.leads', 'clients.manage'] as const;

export async function salesManagerOptions(
  include?: string | null,
): Promise<{ id: string; fullName: string }[]> {
  const holders = db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(inArray(permissions.code, [...OWNER_PERMISSIONS]));

  const rows = await db
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .where(
      or(
        and(eq(users.active, true), sql`${users.id} IN ${holders}`),
        // The current holder, whoever they now are. Rendering them is what
        // stops the next save from erasing them.
        include ? eq(users.id, include) : sql`false`,
      ),
    )
    .orderBy(asc(users.fullName));

  return rows;
}
