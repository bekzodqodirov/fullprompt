'use server';

import { eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { roles, userRoles, users, userWarehouses } from '@/modules/platform/db/schema';
import { authorize } from '@/modules/platform/rbac/authorize';
import { diffFields, writeAudit } from '@/modules/platform/audit/service';
import { hashPassword } from '@/modules/platform/auth/password';
import { requestMeta } from '@/modules/platform/auth/session';

export interface UserFormState {
  error?: 'validation' | 'phone_exists' | 'super_admin_locked';
}

const userSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(5).max(30),
  username: z.string().trim().max(50).optional().or(z.literal('')),
  password: z.string().max(200).optional().or(z.literal('')),
  locale: z.enum(['ru', 'uz', 'zh-CN', 'en']),
  // Not `z.enum(ROLE_CODES)`: roles the owner invents on /admin/roles are just
  // as real as the shipped nine. Existence is checked against the table below.
  roleCodes: z.array(z.string().trim().min(1)).min(1),
  warehouseIds: z.array(z.string().uuid()),
});

function parseForm(formData: FormData) {
  return userSchema.safeParse({
    fullName: formData.get('fullName'),
    phone: formData.get('phone'),
    username: formData.get('username') ?? '',
    password: formData.get('password') ?? '',
    locale: formData.get('locale'),
    roleCodes: formData.getAll('roleCodes'),
    warehouseIds: formData.getAll('warehouseIds'),
  });
}

/**
 * Turn ticked role codes into ids, or refuse.
 *
 * Resolved BEFORE the person is written, and refusing when a code does not
 * resolve: a code deleted between opening the form and saving it would
 * otherwise be dropped in silence, and the admin would be told the save
 * succeeded while the person ended up with fewer roles than was ticked.
 */
async function resolveRoleIds(roleCodes: string[]): Promise<string[] | null> {
  const wanted = [...new Set(roleCodes)];
  const rows = await db.select({ id: roles.id }).from(roles).where(inArray(roles.code, wanted));
  return rows.length === wanted.length ? rows.map((row) => row.id) : null;
}

async function syncRolesAndWarehouses(
  userId: string,
  roleIds: string[],
  warehouseIds: string[],
): Promise<void> {
  await db.delete(userRoles).where(eq(userRoles.userId, userId));
  if (roleIds.length) {
    await db.insert(userRoles).values(roleIds.map((roleId) => ({ userId, roleId })));
  }
  await db.delete(userWarehouses).where(eq(userWarehouses.userId, userId));
  if (warehouseIds.length) {
    await db.insert(userWarehouses).values(warehouseIds.map((warehouseId) => ({ userId, warehouseId })));
  }
}

export async function createUserAction(
  _prev: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  const actor = await authorize('admin.users.manage');
  const parsed = parseForm(formData);
  if (!parsed.success || !parsed.data.password) return { error: 'validation' };

  const existing = await db.query.users.findFirst({ where: eq(users.phone, parsed.data.phone) });
  if (existing) return { error: 'phone_exists' };

  const roleIds = await resolveRoleIds(parsed.data.roleCodes);
  if (!roleIds) return { error: 'validation' };
  // The grants editor's rule («you cannot grant what you do not hold»,
  // roles.ts) finally applied to ASSIGNMENT too: until the annul round, any
  // admin could tick super_admin on themselves — and the annul is the first
  // super_admin-only DESTRUCTIVE power, so the assignment door is now part
  // of that gate.
  if (parsed.data.roleCodes.includes('super_admin') && !actor.roles.includes('super_admin')) {
    return { error: 'super_admin_locked' };
  }

  const [row] = await db
    .insert(users)
    .values({
      fullName: parsed.data.fullName,
      phone: parsed.data.phone,
      username: parsed.data.username || null,
      passwordHash: await hashPassword(parsed.data.password),
      locale: parsed.data.locale,
    })
    .returning();
  if (!row) return { error: 'validation' };

  await syncRolesAndWarehouses(row.id, roleIds, parsed.data.warehouseIds);

  const meta = await requestMeta();
  await writeAudit(
    db,
    { actorId: actor.id, ...meta },
    {
      entityType: 'user',
      entityId: row.id,
      action: 'create',
      after: {
        fullName: parsed.data.fullName,
        phone: parsed.data.phone,
        username: parsed.data.username || null,
        locale: parsed.data.locale,
        roles: parsed.data.roleCodes,
        warehouses: parsed.data.warehouseIds,
      },
    },
  );

  revalidatePath('/admin/users');
  redirect('/admin/users');
}

export async function updateUserAction(
  id: string,
  _prev: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  const actor = await authorize('admin.users.manage');
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: 'validation' };

  const before = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!before) return { error: 'validation' };

  const duplicate = await db.query.users.findFirst({ where: eq(users.phone, parsed.data.phone) });
  if (duplicate && duplicate.id !== id) return { error: 'phone_exists' };

  const roleIds = await resolveRoleIds(parsed.data.roleCodes);
  if (!roleIds) return { error: 'validation' };

  const beforeRoles = (
    await db
      .select({ code: roles.code })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, id))
  ).map((r) => r.code);
  const beforeWhs = (
    await db
      .select({ warehouseId: userWarehouses.warehouseId })
      .from(userWarehouses)
      .where(eq(userWarehouses.userId, id))
  ).map((w) => w.warehouseId);

  // Adding OR removing super_admin is the owner's move alone (the annul
  // round's C10): granting it is self-escalation one form post away, and
  // removing it is locking the owner out with the same post.
  const hadSuper = beforeRoles.includes('super_admin');
  const wantsSuper = parsed.data.roleCodes.includes('super_admin');
  if (hadSuper !== wantsSuper && !actor.roles.includes('super_admin')) {
    return { error: 'super_admin_locked' };
  }

  const values: Record<string, unknown> = {
    fullName: parsed.data.fullName,
    phone: parsed.data.phone,
    username: parsed.data.username || null,
    locale: parsed.data.locale,
  };
  if (parsed.data.password) {
    values.passwordHash = await hashPassword(parsed.data.password);
  }

  await db.update(users).set(values).where(eq(users.id, id));
  await syncRolesAndWarehouses(id, roleIds, parsed.data.warehouseIds);

  const diff = diffFields(
    {
      fullName: before.fullName,
      phone: before.phone,
      username: before.username,
      locale: before.locale,
      roles: beforeRoles.sort(),
      warehouses: beforeWhs.sort(),
      password: null,
    },
    {
      fullName: parsed.data.fullName,
      phone: parsed.data.phone,
      username: parsed.data.username || null,
      locale: parsed.data.locale,
      roles: [...parsed.data.roleCodes].sort(),
      warehouses: [...parsed.data.warehouseIds].sort(),
      password: parsed.data.password ? '(changed)' : null,
    },
  );
  if (diff) {
    const meta = await requestMeta();
    await writeAudit(
      db,
      { actorId: actor.id, ...meta },
      { entityType: 'user', entityId: id, action: 'update', ...diff },
    );
  }

  revalidatePath('/admin/users');
  redirect('/admin/users');
}

export async function toggleUserActiveAction(id: string): Promise<void> {
  const actor = await authorize('admin.users.manage');
  const before = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!before || before.id === actor.id) return;
  await db.update(users).set({ active: !before.active }).where(eq(users.id, id));
  const meta = await requestMeta();
  await writeAudit(
    db,
    { actorId: actor.id, ...meta },
    {
      entityType: 'user',
      entityId: id,
      action: 'update',
      before: { active: before.active },
      after: { active: !before.active },
    },
  );
  revalidatePath('/admin/users');
}
