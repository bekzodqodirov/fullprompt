'use server';

import { revalidatePath } from 'next/cache';
import { authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  RoleError,
  createRole,
  deleteRole,
  renameRole,
  roleSchema,
  setRoleGrants,
  setRoleScoped,
} from '@/modules/platform/rbac/roles';

export interface RoleFormState {
  ok?: boolean;
  error?: string;
}

/**
 * Every action here reshapes what other people can do, so each one loads the
 * FULL actor — the service needs the editor's own permissions and roles to
 * apply its guardrails, not just a yes/no on `platform.roles.manage`.
 */
async function editor() {
  const actor = await authorize('platform.roles.manage');
  return {
    actor,
    editor: { id: actor.id, permissions: actor.permissions, roles: actor.roles as string[] },
    meta: await requestMeta(),
  };
}

export async function saveGrantsAction(
  _prev: RoleFormState,
  formData: FormData,
): Promise<RoleFormState> {
  const roleId = String(formData.get('roleId') ?? '');
  // The form posts one `grant` entry per ticked box; an untouched role posts
  // none, which is a real "no permissions" answer rather than a missing field
  // — the whole form is submitted at once, never a subset.
  const codes = formData.getAll('grant').map(String);
  const { actor, editor: who, meta } = await editor();
  try {
    await setRoleGrants(roleId, codes, who, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof RoleError) return { error: err.code };
    throw err;
  }
  revalidatePath('/admin/roles');
  return { ok: true };
}

export async function createRoleAction(
  _prev: RoleFormState,
  formData: FormData,
): Promise<RoleFormState> {
  const parsed = roleSchema.safeParse({
    code: formData.get('code'),
    name: formData.get('name'),
    description: formData.get('description') ?? '',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message === 'lowercase_snake_case' ? 'bad_code' : 'validation' };
  }
  const { actor, editor: who, meta } = await editor();
  try {
    await createRole(parsed.data, who, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof RoleError) return { error: err.code };
    throw err;
  }
  revalidatePath('/admin/roles');
  return { ok: true };
}

/**
 * Tie or untie a role's powers to the holder's own warehouses (0049). Same
 * door, same guardrails as the grants — the service refuses an own-role
 * edit for the same self-widening reason.
 */
export async function setRoleScopedAction(formData: FormData): Promise<void> {
  const roleId = String(formData.get('roleId') ?? '');
  const scoped = String(formData.get('scoped') ?? '') === 'true';
  const { actor, editor: who, meta } = await editor();
  try {
    await setRoleScoped(roleId, scoped, who, { actorId: actor.id, ...meta });
  } catch (err) {
    if (!(err instanceof RoleError)) throw err;
  }
  revalidatePath('/admin/roles');
}

export async function renameRoleAction(formData: FormData): Promise<void> {
  const roleId = String(formData.get('roleId') ?? '');
  const { actor, meta } = await editor();
  try {
    await renameRole(
      roleId,
      String(formData.get('name') ?? ''),
      String(formData.get('description') ?? ''),
      { actorId: actor.id, ...meta },
    );
  } catch (err) {
    if (!(err instanceof RoleError)) throw err;
  }
  revalidatePath('/admin/roles');
}

export async function deleteRoleAction(formData: FormData): Promise<void> {
  const roleId = String(formData.get('roleId') ?? '');
  const { actor, meta } = await editor();
  try {
    await deleteRole(roleId, { actorId: actor.id, ...meta });
  } catch (err) {
    if (!(err instanceof RoleError)) throw err;
  }
  revalidatePath('/admin/roles');
}
