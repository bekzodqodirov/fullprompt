'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getActor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  EntityError,
  canWriteEntity,
  createRecord,
  recordById,
  recordSchema,
  resolveEntity,
  updateRecord,
} from '@/modules/platform/entities/service';

export interface RecordFormState {
  ok?: boolean;
  error?: string;
}

/**
 * The write gate is the ENTITY'S OWN list (chosen when the owner invented
 * it), not a fixed code — an empty list deliberately means any signed-in
 * member of staff, because half the point of these lists is that everyone
 * keeps them current.
 */
async function writer(entityCode: string) {
  const actor = await getActor();
  if (!actor) return null;
  const entity = await resolveEntity(entityCode);
  if (!entity?.custom) return null;
  if (!canWriteEntity(entity, actor.permissions)) return null;
  return { actorId: actor.id, ...(await requestMeta()) };
}

export async function createRecordAction(
  entityCode: string,
  _prev: RecordFormState,
  form: FormData,
): Promise<RecordFormState> {
  const parsed = recordSchema.safeParse({
    name: String(form.get('name') ?? ''),
    note: String(form.get('note') ?? ''),
  });
  if (!parsed.success) return { error: 'validation' };
  const ctx = await writer(entityCode);
  if (!ctx) return { error: 'forbidden' };
  let id: string;
  try {
    id = await createRecord(entityCode, parsed.data, ctx);
  } catch (err) {
    if (err instanceof EntityError) return { error: err.code };
    throw err;
  }
  revalidatePath(`/o/${entityCode}`);
  redirect(`/o/${entityCode}/${id}`);
}

export async function updateRecordAction(
  recordId: string,
  _prev: RecordFormState,
  form: FormData,
): Promise<RecordFormState> {
  const record = await recordById(recordId);
  if (!record) return { error: 'not_found' };
  const parsed = recordSchema.safeParse({
    name: String(form.get('name') ?? ''),
    note: String(form.get('note') ?? ''),
  });
  if (!parsed.success) return { error: 'validation' };
  const ctx = await writer(record.entityCode);
  if (!ctx) return { error: 'forbidden' };
  // The checkbox idiom: hidden 'false' first, the tick appends 'true', and
  // the LAST value is the real answer (the #171 lesson).
  const activeValues = form.getAll('active').map(String);
  try {
    await updateRecord(
      recordId,
      {
        name: parsed.data.name,
        note: parsed.data.note,
        active: activeValues[activeValues.length - 1] !== 'false',
      },
      ctx,
    );
  } catch (err) {
    if (err instanceof EntityError) return { error: err.code };
    throw err;
  }
  revalidatePath(`/o/${record.entityCode}/${recordId}`);
  revalidatePath(`/o/${record.entityCode}`);
  return { ok: true };
}
