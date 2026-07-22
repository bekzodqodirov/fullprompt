'use server';

import { eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { roles, userRoles, users, userWarehouses } from '@/modules/platform/db/schema';
import { authorize } from '@/modules/platform/rbac/authorize';
import { ROLE_CODES } from '@/modules/platform/rbac/catalog';
import { diffFields, writeAudit } from '@/modules/platform/audit/service';
import { hashPassword } from '@/modules/platform/auth/password';
import { requestMeta } from '@/modules/platform/auth/session';

export interface UserFormState {
  error?: 'validation' | 'phone_exists';
}

const userSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(5).max(30),
  username: z.string().trim().max(50).optional().or(z.literal('')),
  password: z.string().max(200).optional().or(z.literal('')),
  locale: z.enum(['ru', 'uz', 'zh-CN']),
  roleCodes: z.array(z.enum(ROLE_CODES)).min(1),
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

async function syncRolesAndWarehouses(
  userId: string,
  roleCodes: string[],
  warehouseIds: string[],
): Promise<void> {
  const roleRows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(inArray(roles.code, roleCodes));
  await db.delete(userRoles).where(eq(userRoles.userId, userId));
  if (roleRows.length) {
    await db.insert(userRoles).values(roleRows.map((r) => ({ userId, roleId: r.id })));
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

  await syncRolesAndWarehouses(row.id, parsed.data.roleCodes, parsed.data.warehouseIds);

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
  await syncRolesAndWarehouses(id, parsed.data.roleCodes, parsed.data.warehouseIds);

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
