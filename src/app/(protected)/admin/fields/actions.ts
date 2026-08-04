'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { FIELDS_ADMIN_PERMISSION } from '@/modules/platform/fields/registry';
import { deleteField, saveField } from '@/modules/platform/fields/service';
import { FieldError, fieldSchema } from '@/modules/platform/fields/types';

export interface FieldAdminState {
  ok?: boolean;
  error?: string;
  /** Extra context for the message — the fields that block a delete. */
  detail?: string;
}

async function ctx() {
  const actor = await authorize(FIELDS_ADMIN_PERMISSION);
  return { actorId: actor.id, ...(await requestMeta()) };
}

const str = (formData: FormData, name: string) => String(formData.get(name) ?? '').trim();

function num(formData: FormData, name: string): number | undefined {
  const raw = str(formData, name);
  if (!raw) return undefined;
  const value = Number(raw.replace(',', '.'));
  return Number.isFinite(value) ? value : undefined;
}

export async function saveFieldAction(
  _prev: FieldAdminState,
  formData: FormData,
): Promise<FieldAdminState> {
  const showIfField = str(formData, 'showIfField');
  const showIfValues = str(formData, 'showIfValues')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const parsed = fieldSchema.safeParse({
    entityType: str(formData, 'entityType'),
    label: str(formData, 'label'),
    type: str(formData, 'type'),
    options: str(formData, 'options')
      .split(',')
      .map((option) => option.trim())
      .filter(Boolean),
    help: str(formData, 'help'),
    rules: {
      min: num(formData, 'min'),
      max: num(formData, 'max'),
      minLength: num(formData, 'minLength'),
      maxLength: num(formData, 'maxLength'),
      pattern: str(formData, 'pattern') || undefined,
    },
    // Both halves or neither: a parent with no values would hide the field
    // from everyone for ever.
    showIf:
      showIfField && showIfValues.length > 0
        ? { fieldId: showIfField, values: showIfValues }
        : null,
    required: formData.getAll('required').at(-1) === 'on',
    onList: formData.getAll('onList').at(-1) === 'on',
    lookupEntity: str(formData, 'lookupEntity') || null,
    sortOrder: Number(formData.get('sortOrder')) || 100,
    active: formData.getAll('active').at(-1) !== 'off',
  });
  if (!parsed.success) return { error: 'validation' };

  const id = str(formData, 'id') || undefined;
  try {
    await saveField({ ...parsed.data, id }, await ctx());
  } catch (err) {
    if (err instanceof FieldError) return { error: err.code, detail: err.fieldLabel };
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  revalidatePath('/admin/fields');
  return { ok: true };
}

export async function deleteFieldAction(id: string): Promise<FieldAdminState> {
  try {
    await deleteField(id, await ctx());
  } catch (err) {
    if (err instanceof FieldError) return { error: err.code, detail: err.fieldLabel };
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  revalidatePath('/admin/fields');
  return { ok: true };
}
