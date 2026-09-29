'use server';

import { inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { roles } from '@/modules/platform/db/schema';
import { authorize } from '@/modules/platform/rbac/authorize';
import { hashPassword } from '@/modules/platform/auth/password';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  createLogin,
  enableLogin,
  toggleUserActive,
  updateLogin,
  UserWriteError,
} from '@/modules/platform/users/service';

/**
 * /admin/users' doors — thin (0120). Every write, and both rules that decide
 * what a person may become (a no-login row holds no role; super_admin is a
 * super_admin's move), live in the ONE writer, platform/users/service.ts: this
 * file authorizes, parses, hashes and maps a refusal to a sentence.
 */

export interface UserFormState {
  ok?: boolean;
  error?:
    | 'validation'
    | 'phone_exists'
    | 'super_admin_locked'
    | 'username_exists'
    | 'no_login_row'
    | 'already_login'
    | 'inactive_person'
    | 'not_found'
    | 'bad_phone';
}

const localeSchema = z.enum(['ru', 'uz', 'zh-CN', 'en']);

const userSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(5).max(30),
  username: z.string().trim().max(50).optional().or(z.literal('')),
  password: z.string().max(200).optional().or(z.literal('')),
  locale: localeSchema,
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

/** The writer's refusal, in the form's words; anything else is not ours to name (#472). */
function refusal(err: unknown): UserFormState | null {
  if (err instanceof UserWriteError) {
    switch (err.code) {
      case 'phone_exists':
      case 'super_admin_locked':
      case 'username_exists':
      case 'no_login_row':
      case 'already_login':
      case 'inactive_person':
      case 'not_found':
      case 'bad_phone':
        return { error: err.code };
      default:
        return { error: 'validation' };
    }
  }
  // A forged warehouse id: the zod checks the uuid SHAPE only, the FK answers.
  const pg = err as { code?: string; cause?: { code?: string } };
  if ((pg?.code ?? pg?.cause?.code) === '23503') return { error: 'validation' };
  return null;
}

export async function createUserAction(
  _prev: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  const actor = await authorize('admin.users.manage');
  const parsed = parseForm(formData);
  if (!parsed.success || !parsed.data.password) return { error: 'validation' };
  const roleIds = await resolveRoleIds(parsed.data.roleCodes);
  if (!roleIds) return { error: 'validation' };
  const passwordHash = await hashPassword(parsed.data.password);
  const meta = await requestMeta();
  try {
    await createLogin(
      {
        fullName: parsed.data.fullName,
        phone: parsed.data.phone,
        username: parsed.data.username || null,
        locale: parsed.data.locale,
        roleIds,
        warehouseIds: parsed.data.warehouseIds,
        passwordHash,
      },
      actor.roles,
      { actorId: actor.id, ...meta },
    );
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
  revalidatePath('/admin/users');
  revalidatePath('/hodimlar');
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
  const roleIds = await resolveRoleIds(parsed.data.roleCodes);
  if (!roleIds) return { error: 'validation' };
  const passwordHash = parsed.data.password ? await hashPassword(parsed.data.password) : null;
  const meta = await requestMeta();
  try {
    await updateLogin(
      id,
      {
        fullName: parsed.data.fullName,
        phone: parsed.data.phone,
        username: parsed.data.username || null,
        locale: parsed.data.locale,
        roleIds,
        warehouseIds: parsed.data.warehouseIds,
        passwordHash,
      },
      actor.roles,
      { actorId: actor.id, ...meta },
    );
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
  revalidatePath('/admin/users');
  revalidatePath('/hodimlar');
  redirect('/admin/users');
}

export async function toggleUserActiveAction(id: string): Promise<void> {
  const actor = await authorize('admin.users.manage');
  const meta = await requestMeta();
  try {
    await toggleUserActive(id, actor.id, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof UserWriteError) return;
    throw err;
  }
  revalidatePath('/admin/users');
  revalidatePath(`/admin/users/${id}`);
  revalidatePath('/hodimlar');
}

const enableLoginInput = z.object({
  id: z.string().uuid(),
  phone: z.string().trim().min(5).max(30),
  username: z.string().trim().max(50),
  password: z.string().min(1).max(200),
  locale: localeSchema,
  roleCodes: z.array(z.string().trim().min(1)).min(1),
  warehouseIds: z.array(z.string().uuid()),
});

/**
 * «Tizimga kirish ochish» — a person who is paid here becomes a login (0120).
 * Called directly from a CONTROLLED client form, never a `<form action>`, so a
 * refusal keeps every typed value; and therefore no `redirect()` — an action
 * called from a click handler rejects with NEXT_REDIRECT (round 60).
 */
export async function enableLoginAction(
  id: string,
  input: {
    phone: string;
    username: string;
    password: string;
    locale: string;
    roleCodes: string[];
    warehouseIds: string[];
  },
): Promise<UserFormState> {
  const actor = await authorize('admin.users.manage');
  const parsed = enableLoginInput.safeParse({ id, ...input });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.path[0] === 'phone' ? 'bad_phone' : 'validation' };
  }
  const roleIds = await resolveRoleIds(parsed.data.roleCodes);
  if (!roleIds) return { error: 'validation' };
  const passwordHash = await hashPassword(parsed.data.password);
  const meta = await requestMeta();
  try {
    await enableLogin(
      parsed.data.id,
      {
        phone: parsed.data.phone,
        username: parsed.data.username || null,
        locale: parsed.data.locale,
        passwordHash,
        roleIds,
        warehouseIds: parsed.data.warehouseIds,
      },
      actor.roles,
      { actorId: actor.id, ...meta },
    );
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
  revalidatePath('/admin/users');
  revalidatePath(`/admin/users/${parsed.data.id}`);
  revalidatePath('/hodimlar');
  return { ok: true };
}
