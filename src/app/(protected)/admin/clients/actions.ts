'use server';

import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { clients } from '@/modules/platform/db/schema';
import { authorize } from '@/modules/platform/rbac/authorize';
import { diffFields, writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';
import { getSetting } from '@/modules/platform/settings/service';
import { nextClientCode } from '@/modules/platform/clients/code';

export interface ClientFormState {
  error?: 'validation' | 'code_exists' | 'code_format';
}

const clientSchema = z.object({
  clientCode: z
    .string()
    .trim()
    .max(20)
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(1).max(200),
  phones: z.string().trim().max(500),
  salesManagerId: z.string().uuid().optional().or(z.literal('')),
  messengerNote: z.string().trim().max(500).optional().or(z.literal('')),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
});

function parseForm(formData: FormData) {
  return clientSchema.safeParse({
    clientCode: formData.get('clientCode'),
    name: formData.get('name'),
    phones: formData.get('phones') ?? '',
    salesManagerId: formData.get('salesManagerId') ?? '',
    messengerNote: formData.get('messengerNote') ?? '',
    notes: formData.get('notes') ?? '',
  });
}

/**
 * Real-world markings are arbitrary short codes (444, GS277, A55 — owner's
 * Kashgar stock file), so manual codes accept any 2–10 alphanumerics.
 * Auto-generated codes still use the configured prefix.
 */
async function validateCodeFormat(code: string): Promise<boolean> {
  return /^[A-Z0-9]{2,10}$/.test(code);
}

function toValues(data: z.infer<typeof clientSchema>) {
  return {
    clientCode: data.clientCode,
    name: data.name,
    phones: data.phones
      ? data.phones
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
      : [],
    salesManagerId: data.salesManagerId || null,
    messengerNote: data.messengerNote || null,
    notes: data.notes || null,
  };
}

export async function createClientAction(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const actor = await authorize('clients.manage');
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: 'validation' };

  // Owner's rule: empty code ⇒ the system assigns the next sequential code;
  // a manually entered code must be well-formed and free.
  const manual = parsed.data.clientCode.length > 0;
  if (manual) {
    if (!(await validateCodeFormat(parsed.data.clientCode))) return { error: 'code_format' };
    const existing = await db.query.clients.findFirst({
      where: sql`upper(${clients.clientCode}) = ${parsed.data.clientCode}`,
    });
    if (existing) return { error: 'code_exists' };
  }

  const values = toValues(parsed.data);
  const row = await db.transaction(async (tx) => {
    if (!manual) {
      const prefix = await getSetting('client_code_prefix');
      values.clientCode = await nextClientCode(tx, prefix);
    }
    const [inserted] = await tx.insert(clients).values(values).returning();
    return inserted;
  });
  if (!row) return { error: 'validation' };

  const meta = await requestMeta();
  await writeAudit(
    db,
    { actorId: actor.id, ...meta },
    {
      entityType: 'client',
      entityId: row.id,
      action: 'create',
      after: values as unknown as Record<string, unknown>,
    },
  );

  revalidatePath('/admin/clients');
  redirect('/admin/clients');
}

export async function updateClientAction(
  id: string,
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const actor = await authorize('clients.manage');
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: 'validation' };
  if (!(await validateCodeFormat(parsed.data.clientCode))) return { error: 'code_format' };

  const before = await db.query.clients.findFirst({ where: eq(clients.id, id) });
  if (!before) return { error: 'validation' };

  const duplicate = await db.query.clients.findFirst({
    where: sql`upper(${clients.clientCode}) = ${parsed.data.clientCode}`,
  });
  if (duplicate && duplicate.id !== id) return { error: 'code_exists' };

  const values = toValues(parsed.data);
  const diff = diffFields(before as unknown as Record<string, unknown>, values);
  await db.update(clients).set(values).where(eq(clients.id, id));
  if (diff) {
    const meta = await requestMeta();
    await writeAudit(
      db,
      { actorId: actor.id, ...meta },
      { entityType: 'client', entityId: id, action: 'update', ...diff },
    );
  }

  revalidatePath('/admin/clients');
  redirect('/admin/clients');
}

export async function toggleClientActiveAction(id: string): Promise<void> {
  const actor = await authorize('clients.manage');
  const before = await db.query.clients.findFirst({ where: eq(clients.id, id) });
  if (!before) return;
  await db.update(clients).set({ active: !before.active }).where(eq(clients.id, id));
  const meta = await requestMeta();
  await writeAudit(
    db,
    { actorId: actor.id, ...meta },
    {
      entityType: 'client',
      entityId: id,
      action: 'update',
      before: { active: before.active },
      after: { active: !before.active },
    },
  );
  revalidatePath('/admin/clients');
}
