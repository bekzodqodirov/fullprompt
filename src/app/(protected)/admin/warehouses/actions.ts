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
import { coordField } from '@/modules/platform/forms/coord';
import { isServerBehind } from '@/modules/platform/db/errors';
import { readTariffZoneField } from '@/modules/wms/costing/tariff-zone-field';
import { mappableZones, setTariffColumnInTx, tariffColumnOf } from '@/modules/wms/costing/tariff-column';
import { freightTablesReady } from '@/modules/wms/costing/freight-ready';
import type { WarehouseFormValues } from './warehouse-form';

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
  /** Where the warehouse stands (round 100, 9B) — see coordField for why
   * emptiness is decided BEFORE coercion. */
  lat: coordField(-90, 90),
  lon: coordField(-180, 180),
});

export interface WarehouseFormState {
  error?: 'validation' | 'code_exists' | 'zone_unknown' | 'server_behind';
  /**
   * The post echoed back on every refusal, so the form HOLDS what was typed
   * (#463: a form that can be refused must hold its inputs) — React's reset
   * after a form action otherwise empties every uncontrolled field.
   */
  values?: WarehouseFormValues;
  /** Bumped per answer; the form is keyed on it so the echoed defaults take. */
  n?: number;
}

const str = (formData: FormData, key: string) => {
  const v = formData.get(key);
  return typeof v === 'string' ? v : '';
};

function echo(formData: FormData): WarehouseFormValues {
  return {
    code: str(formData, 'code'),
    name: str(formData, 'name'),
    country: str(formData, 'country'),
    type: str(formData, 'type'),
    timezone: str(formData, 'timezone'),
    batchPrefix: str(formData, 'batchPrefix'),
    address: str(formData, 'address'),
    capacityM3: str(formData, 'capacityM3'),
    lat: str(formData, 'lat'),
    lon: str(formData, 'lon'),
    issuesToClients: checkbox(formData, 'issuesToClients', false),
    allowsQuickBatch: checkbox(formData, 'allowsQuickBatch', true),
    tariffZone: readTariffZoneField(formData) ?? null,
  };
}

let answers = 0;
const refuse = (error: NonNullable<WarehouseFormState['error']>, formData: FormData): WarehouseFormState => ({
  error,
  values: echo(formData),
  n: (answers += 1),
});

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
    lat: formData.get('lat') ?? '',
    lon: formData.get('lon') ?? '',
  });
}

function toValues(data: z.infer<typeof warehouseSchema>) {
  return {
    ...data,
    address: data.address || null,
    capacityM3: data.capacityM3 ? String(data.capacityM3) : null,
    // `!== undefined`, not truthiness: 0 is a legal coordinate.
    lat: data.lat !== undefined ? String(data.lat) : null,
    lon: data.lon !== undefined ? String(data.lon) : null,
  };
}

export async function createWarehouseAction(
  _prev: WarehouseFormState,
  formData: FormData,
): Promise<WarehouseFormState> {
  const actor = await authorize('admin.warehouses.manage');
  const parsed = parseForm(formData);
  if (!parsed.success) return refuse('validation', formData);
  // The tariff column (0132, his 2c) is NOT part of the warehouse row: it is
  // its own side table, read and written through costing/tariff-column.ts.
  const zone = readTariffZoneField(formData);
  if (zone) {
    if (!(await freightTablesReady())) return refuse('server_behind', formData);
    if (!(await mappableZones(null)).some((z) => z.zone === zone)) return refuse('zone_unknown', formData);
  }

  const existing = await db.query.warehouses.findFirst({
    where: eq(warehouses.code, parsed.data.code),
  });
  if (existing) return refuse('code_exists', formData);

  const meta = await requestMeta();
  try {
    const row = await db.transaction(async (tx) => {
      const [row] = await tx.insert(warehouses).values(toValues(parsed.data)).returning();
      if (!row) return null;
      if (zone) await setTariffColumnInTx(tx, row.id, zone);
      await writeAudit(
        tx,
        { actorId: actor.id, ...meta, warehouseId: row.id },
        {
          entityType: 'warehouse',
          entityId: row.id,
          action: 'create',
          after: { ...parsed.data, ...(zone ? { tariffZone: zone } : {}) },
        },
      );
      return row;
    });
    if (!row) return refuse('validation', formData);
  } catch (error) {
    if (isServerBehind(error)) return refuse('server_behind', formData);
    throw error;
  }

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
  if (!parsed.success) return refuse('validation', formData);

  const before = await db.query.warehouses.findFirst({ where: eq(warehouses.id, id) });
  if (!before) return refuse('validation', formData);

  const duplicate = await db.query.warehouses.findFirst({
    where: eq(warehouses.code, parsed.data.code),
  });
  if (duplicate && duplicate.id !== id) return refuse('code_exists', formData);

  // undefined = the post did not carry the field (a page drawn before 0132,
  // or one migration behind, where the select is not drawn): LEAVE the
  // mapping alone. null = «— tanlanmagan»: delete it. Read on the pool before
  // the transaction (#714).
  const posted = readTariffZoneField(formData);
  let beforeZone: string | null = null;
  if (posted !== undefined) {
    if (!(await freightTablesReady())) return refuse('server_behind', formData);
    beforeZone = await tariffColumnOf(id);
    if (posted !== null && !(await mappableZones(beforeZone)).some((z) => z.zone === posted)) {
      return refuse('zone_unknown', formData);
    }
  }

  const values = toValues(parsed.data);
  // The zone joins the HISTORY's diff and never the row's own set: the
  // warehouses row has no such column (#502's split-out idiom).
  const zoneChanged = posted !== undefined && posted !== beforeZone;
  const diff = diffFields(
    { ...(before as unknown as Record<string, unknown>), ...(posted !== undefined ? { tariffZone: beforeZone } : {}) },
    { ...values, ...(posted !== undefined ? { tariffZone: posted } : {}) },
  );
  const meta = await requestMeta();
  try {
    // ONE transaction: the row, the column and the history land together.
    await db.transaction(async (tx) => {
      await tx.update(warehouses).set(values).where(eq(warehouses.id, id));
      if (zoneChanged) await setTariffColumnInTx(tx, id, posted);
      if (diff) {
        await writeAudit(
          tx,
          { actorId: actor.id, ...meta, warehouseId: id },
          { entityType: 'warehouse', entityId: id, action: 'update', ...diff },
        );
      }
    });
  } catch (error) {
    if (isServerBehind(error)) return refuse('server_behind', formData);
    throw error;
  }

  revalidatePath('/admin/warehouses');
  revalidatePath(`/admin/warehouses/${id}`);
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
