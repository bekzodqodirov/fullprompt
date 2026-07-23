'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { truckPresets } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';

export interface TruckFormState {
  ok?: boolean;
  error?: string;
}

const truckSchema = z.object({
  id: z.string().uuid().optional().or(z.literal('')),
  name: z.string().trim().min(1).max(120),
  maxKg: z.coerce.number().positive().max(100_000),
  maxM3: z.coerce.number().positive().max(1_000),
});

/** Create or update a truck preset (owner manages these himself now). */
export async function saveTruckAction(
  _prev: TruckFormState,
  formData: FormData,
): Promise<TruckFormState> {
  const parsed = truckSchema.safeParse({
    id: formData.get('id') ?? '',
    name: formData.get('name'),
    maxKg: formData.get('maxKg'),
    maxM3: formData.get('maxM3'),
  });
  if (!parsed.success) return { error: 'validation' };

  let actor;
  try {
    actor = await authorize('plans.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();

  const values = {
    name: parsed.data.name,
    maxKg: String(parsed.data.maxKg),
    maxM3: String(parsed.data.maxM3),
  };
  let id = parsed.data.id || null;
  if (id) {
    await db.update(truckPresets).set(values).where(eq(truckPresets.id, id));
  } else {
    const [row] = await db.insert(truckPresets).values(values).returning({ id: truckPresets.id });
    id = row!.id;
  }
  await writeAudit(db, { actorId: actor.id, ...meta }, {
    entityType: 'truck_preset',
    entityId: id,
    action: parsed.data.id ? 'update' : 'create',
    after: values,
  });
  revalidatePath('/trucks');
  return { ok: true };
}

/** Hide a preset from the plan editor (kept for history, never deleted). */
export async function setTruckActiveAction(formData: FormData): Promise<void> {
  const id = z.string().uuid().safeParse(formData.get('id'));
  const active = formData.get('active') === '1';
  if (!id.success) return;
  let actor;
  try {
    actor = await authorize('plans.manage');
  } catch (err) {
    if (err instanceof AuthError) return;
    throw err;
  }
  const meta = await requestMeta();
  await db.update(truckPresets).set({ active }).where(eq(truckPresets.id, id.data));
  await writeAudit(db, { actorId: actor.id, ...meta }, {
    entityType: 'truck_preset',
    entityId: id.data,
    action: 'update',
    after: { active },
  });
  revalidatePath('/trucks');
}
