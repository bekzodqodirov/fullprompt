'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { costTypes } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';

export interface CostTypeFormState {
  ok?: boolean;
  error?: string;
}

const costTypeSchema = z.object({
  id: z.string().uuid().optional().or(z.literal('')),
  name: z.string().trim().min(1).max(120),
});

/**
 * Create or rename an expense type (owner, 2026-07-28: "shuni men yana o'zim
 * qo'sha olamanmi yokida hard coded qilib yozilganmi").
 *
 * The NAME is all a person supplies. The code is internal plumbing — the
 * seeded ones ('crating', 'unload') are matched by services, a new one is
 * matched by nothing — so asking the owner to invent codes would be asking
 * him to name our variables.
 */
export async function saveCostTypeAction(
  _prev: CostTypeFormState,
  formData: FormData,
): Promise<CostTypeFormState> {
  const parsed = costTypeSchema.safeParse({
    id: formData.get('id') ?? '',
    name: formData.get('name'),
  });
  if (!parsed.success) return { error: 'validation' };

  let actor;
  try {
    actor = await authorize('admin.dictionaries.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();

  let id = parsed.data.id || null;
  if (id) {
    await db.update(costTypes).set({ name: parsed.data.name }).where(eq(costTypes.id, id));
  } else {
    const code = `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const [row] = await db
      .insert(costTypes)
      .values({ code, name: parsed.data.name })
      .returning({ id: costTypes.id });
    id = row!.id;
  }
  await writeAudit(db, { actorId: actor.id, ...meta }, {
    entityType: 'cost_type',
    entityId: id,
    action: parsed.data.id ? 'update' : 'create',
    after: { name: parsed.data.name },
  });
  revalidatePath('/admin/cost-types');
  return { ok: true };
}

/** Hide a type from the expense forms — history keeps it, so never deleted. */
export async function setCostTypeActiveAction(formData: FormData): Promise<void> {
  const id = z.string().uuid().safeParse(formData.get('id'));
  const active = formData.get('active') === '1';
  if (!id.success) return;
  let actor;
  try {
    actor = await authorize('admin.dictionaries.manage');
  } catch (err) {
    if (err instanceof AuthError) return;
    throw err;
  }
  const meta = await requestMeta();
  await db.update(costTypes).set({ active }).where(eq(costTypes.id, id.data));
  await writeAudit(db, { actorId: actor.id, ...meta }, {
    entityType: 'cost_type',
    entityId: id.data,
    action: 'update',
    after: { active },
  });
  revalidatePath('/admin/cost-types');
}
