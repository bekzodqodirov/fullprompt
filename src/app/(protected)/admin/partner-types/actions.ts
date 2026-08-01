'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { partnerTypes } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';

export interface PartnerTypeFormState {
  ok?: boolean;
  error?: string;
}

const schema = z.object({
  id: z.string().uuid().optional().or(z.literal('')),
  name: z.string().trim().min(1).max(120),
});

/**
 * Counterparty types, owned by the owner (his rule for every dictionary in
 * this system). The NAME is all he supplies: the code is internal plumbing —
 * nothing branches on it — so asking him to invent codes would be asking him
 * to name our variables.
 */
export async function savePartnerTypeAction(
  _prev: PartnerTypeFormState,
  formData: FormData,
): Promise<PartnerTypeFormState> {
  const parsed = schema.safeParse({ id: formData.get('id') ?? '', name: formData.get('name') });
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
    await db.update(partnerTypes).set({ name: parsed.data.name }).where(eq(partnerTypes.id, id));
  } else {
    const code = `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const [row] = await db
      .insert(partnerTypes)
      .values({ code, name: parsed.data.name })
      .returning({ id: partnerTypes.id });
    id = row!.id;
  }
  await writeAudit(db, { actorId: actor.id, ...meta }, {
    entityType: 'partner_type',
    entityId: id,
    action: parsed.data.id ? 'update' : 'create',
    after: { name: parsed.data.name },
  });
  revalidatePath('/admin/partner-types');
  revalidatePath('/kontragentlar');
  return { ok: true };
}

/** Hide a type from the forms. Never deleted — accounts still point at it. */
export async function setPartnerTypeActiveAction(formData: FormData): Promise<void> {
  const id = z.string().uuid().safeParse(formData.get('id'));
  if (!id.success) return;
  const active = formData.get('active') === '1';
  try {
    const actor = await authorize('admin.dictionaries.manage');
    const meta = await requestMeta();
    await db.update(partnerTypes).set({ active }).where(eq(partnerTypes.id, id.data));
    await writeAudit(db, { actorId: actor.id, ...meta }, {
      entityType: 'partner_type',
      entityId: id.data,
      action: 'update',
      after: { active },
    });
  } catch (err) {
    if (err instanceof AuthError) return;
    throw err;
  }
  revalidatePath('/admin/partner-types');
  revalidatePath('/kontragentlar');
}
