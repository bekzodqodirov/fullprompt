'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { warehouses } from '@/modules/platform/db/schema';
import { authorize } from '@/modules/platform/rbac/authorize';
import { diffFields, writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';
import { checkbox } from '@/modules/platform/forms/checkbox';

const warehouseSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(10)
    .regex(/^[A-Za-z0-9]+$/)
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(1).max(200),
  country: z
    .string()
    .trim()
    .length(2)
    .transform((v) => v.toUpperCase()),
  type: z.enum(['origin', 'hub', 'customs', 'distribution']),
  timezone: z.string().trim().min(1).max(50),
  batchPrefix: z
    .string()
    .trim()
    .min(1)
    .max(10)
    .transform((v) => v.toUpperCase()),
  address: z.string().trim().max(500).optional().or(z.literal('')),
  /** Storage capacity in m³ for the fill indicator (empty = no indicator). */
  capacityM3: z
    .string()
    .trim()
    .transform((v) => v.replace(',', '.'))
    .pipe(z.coerce.number().positive().max(1_000_000))
    .optional()
    .or(z.literal('')),
  /** Does a client collect cargo here? (owner: only TAS and AND.) */
  issuesToClients: z.boolean(),
  allowsQuickBatch: z.boolean(),
});

export interface WarehouseFormState {
  error?: 'validation' | 'code_exists';
}

function parseForm(formData: FormData) {
  return warehouseSchema.safeParse({
    code: formData.get('code'),
    name: formData.get('name'),
    country: formData.get('country'),
    type: formData.get('type'),
    timezone: formData.get('timezone'),
    batchPrefix: formData.get('batchPrefix'),
    address: formData.get('address') ?? '',
    capacityM3: formData.get('capacityM3') ?? '',
    issuesToClients: checkbox(formData, 'issuesToClients', false),
    allowsQuickBatch: checkbox(formData, 'allowsQuickBatch', true),
  });
}

function toValues(data: z.infer<typeof warehouseSchema>) {
  return {
    ...data,
    address: data.address || null,
    capacityM3: data.capacityM3 ? String(data.capacityM3) : null,
  };
}

export async function createWarehouseAction(
  _prev: WarehouseFormState,
  formData: FormData,
): Promise<WarehouseFormState> {
  const actor = await authorize('admin.warehouses.manage');
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: 'validation' };

  const existing = await db.query.warehouses.findFirst({
    where: eq(warehouses.code, parsed.data.code),
  });
  if (existing) return { error: 'code_exists' };

  const meta = await requestMeta();
  const [row] = await db.insert(warehouses).values(toValues(parsed.data)).returning();
  if (!row) return { error: 'validation' };
  await writeAudit(
    db,
    { actorId: actor.id, ...meta, warehouseId: row.id },
    { entityType: 'warehouse', entityId: row.id, action: 'create', after: parsed.data },
  );

  revalidatePath('/admin/warehouses');
  redirect('/admin/warehouses');
}

export async function updateWarehouseAction(
  id: string,
  _prev: WarehouseFormState,
  formData: FormData,
): Promise<WarehouseFormState> {
  const actor = await authorize('admin.warehouses.manage');
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: 'validation' };

  const before = await db.query.warehouses.findFirst({ where: eq(warehouses.id, id) });
  if (!before) return { error: 'validation' };

  const duplicate = await db.query.warehouses.findFirst({
    where: eq(warehouses.code, parsed.data.code),
  });
  if (duplicate && duplicate.id !== id) return { error: 'code_exists' };

  const values = toValues(parsed.data);
  const diff = diffFields(before as unknown as Record<string, unknown>, values);
  await db.update(warehouses).set(values).where(eq(warehouses.id, id));
  if (diff) {
    const meta = await requestMeta();
    await writeAudit(
      db,
      { actorId: actor.id, ...meta, warehouseId: id },
      { entityType: 'warehouse', entityId: id, action: 'update', ...diff },
    );
  }

  revalidatePath('/admin/warehouses');
  redirect('/admin/warehouses');
}

export async function toggleWarehouseActiveAction(id: string): Promise<void> {
  const actor = await authorize('admin.warehouses.manage');
  const before = await db.query.warehouses.findFirst({ where: eq(warehouses.id, id) });
  if (!before) return;
  await db.update(warehouses).set({ active: !before.active }).where(eq(warehouses.id, id));
  const meta = await requestMeta();
  await writeAudit(
    db,
    { actorId: actor.id, ...meta, warehouseId: id },
    {
      entityType: 'warehouse',
      entityId: id,
      action: 'update',
      before: { active: before.active },
      after: { active: !before.active },
    },
  );
  revalidatePath('/admin/warehouses');
}
