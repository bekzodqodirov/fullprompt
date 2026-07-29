'use server';

import { revalidatePath } from 'next/cache';
import { getActor } from '../rbac/authorize';
import { requestMeta } from '../auth/session';
import { canWriteEntity, resolveEntity } from '../entities/service';
import { setFieldValues } from './service';
import { FieldError } from './types';

export interface FieldsFormState {
  ok?: boolean;
  error?: string;
  /** Which field the complaint is about, so the message can name it. */
  field?: string;
}

/**
 * Custom answers arrive as `cf_<fieldId>`; multiselect and money send several
 * under the same name, in DOM order.
 *
 * Exported because three different kinds of form need it: the cards whose
 * built-in inputs travel in the same FormData, the cards that post a custom
 * fields form of their own, and the create forms that validate before writing.
 */
export async function customValues(formData: FormData): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const key of new Set(formData.keys())) {
    if (!key.startsWith('cf_')) continue;
    const values = formData.getAll(key);
    out[key.slice(3)] = values.length > 1 ? values : values[0];
  }
  return out;
}

/**
 * Save one record's custom answers.
 *
 * The permission comes from the registry rather than from the caller, so a
 * card cannot accidentally offer looser rights than the object deserves — and
 * the list is per object because the cards are not uniform (a sales manager
 * has always filled in client fields with `crm.leads`).
 */
export async function saveCustomFieldsAction(
  entityType: string,
  entityId: string,
  revalidate: string,
  _prev: FieldsFormState,
  formData: FormData,
): Promise<FieldsFormState> {
  const spec = await resolveEntity(entityType);
  if (!spec) return { error: 'unknown_entity' };
  const actor = await getActor();
  if (!actor) return { error: 'unauthenticated' };
  if (!canWriteEntity(spec, actor.permissions)) {
    return { error: 'forbidden' };
  }

  try {
    await setFieldValues(entityType, entityId, await customValues(formData), {
      actorId: actor.id,
      ...(await requestMeta()),
    });
  } catch (err) {
    if (err instanceof FieldError) return { error: err.code, field: err.fieldLabel };
    throw err;
  }
  revalidatePath(revalidate);
  return { ok: true };
}
