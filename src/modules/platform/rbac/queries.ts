import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { roles, userRoles, users } from '../db/schema';

export async function salesManagerOptions() {
  return db
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(roles.code, 'sales_manager'))
    .orderBy(asc(users.fullName));
}
