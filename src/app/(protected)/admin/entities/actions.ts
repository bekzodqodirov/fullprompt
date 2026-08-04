'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  EntityError,
  createCustomEntity,
  customEntitySchema,
  updateCustomEntity,
  type WriteChoice,
} from '@/modules/platform/entities/service';

export interface EntityFormState {
  ok?: boolean;
  error?: string;
}

/** Same door as fields and dictionaries — defining objects IS reference-data work (#179). */
async function ctx() {
  const actor = await authorize('admin.dictionaries.manage');
  return { actorId: actor.id, ...(await requestMeta()) };
}

export async function createEntityAction(
  _prev: EntityFormState,
  form: FormData,
): Promise<EntityFormState> {
  const parsed = customEntitySchema.safeParse({
    label: String(form.get('label') ?? ''),
    writeChoice: String(form.get('writeChoice') ?? 'everyone'),
  });
  if (!parsed.success) return { error: 'validation' };
  try {
    await createCustomEntity(parsed.data, await ctx());
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    if (err instanceof EntityError) return { error: err.code };
    throw err;
  }
  revalidatePath('/admin/entities');
  revalidatePath('/o');
  return { ok: true };
}

export async function updateEntityAction(
  code: string,
  _prev: EntityFormState,
  form: FormData,
): Promise<EntityFormState> {
  const parsed = customEntitySchema.safeParse({
    label: String(form.get('label') ?? ''),
    writeChoice: String(form.get('writeChoice') ?? 'everyone'),
  });
  if (!parsed.success) return { error: 'validation' };
  try {
    await updateCustomEntity(
      code,
      { label: parsed.data.label, writeChoice: parsed.data.writeChoice as WriteChoice },
      await ctx(),
    );
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    if (err instanceof EntityError) return { error: err.code };
    throw err;
  }
  revalidatePath('/admin/entities');
  revalidatePath('/o');
  return { ok: true };
}

export async function toggleEntityAction(code: string, active: boolean): Promise<EntityFormState> {
  try {
    await updateCustomEntity(code, { active }, await ctx());
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    if (err instanceof EntityError) return { error: err.code };
    throw err;
  }
  revalidatePath('/admin/entities');
  revalidatePath('/o');
  return { ok: true };
}
