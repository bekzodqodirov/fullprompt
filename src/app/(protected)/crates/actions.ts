'use server';

import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { db } from '@/modules/platform/db/client';
import { crates } from '@/modules/platform/db/schema';
import { authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  CrateError,
  createCrate,
  createCrateSchema,
  dissolveCrate,
  updateCrate,
} from '@/modules/wms/crates/service';

export interface CrateActionResult {
  ok: boolean;
  crateId?: string;
  code?: string;
  error?: string;
}

export async function createCrateAction(input: unknown): Promise<CrateActionResult> {
  const parsed = createCrateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const actor = await authorize('crates.manage', { warehouseId: parsed.data.warehouseId });
  const meta = await requestMeta();
  try {
    const crate = await createCrate(parsed.data, { actorId: actor.id, ...meta });
    return { ok: true, crateId: crate.id, code: crate.code };
  } catch (err) {
    if (err instanceof CrateError) return { ok: false, error: err.code };
    throw err;
  }
}

export async function dissolveCrateAction(formData: FormData): Promise<void> {
  const crateId = String(formData.get('crateId') ?? '');
  const crate = await db.query.crates.findFirst({ where: eq(crates.id, crateId) });
  if (!crate) return;
  const actor = await authorize('crates.manage', { warehouseId: crate.warehouseId });
  const meta = await requestMeta();
  await dissolveCrate(crateId, { actorId: actor.id, ...meta });
  redirect('/crates');
}

export async function updateCrateAction(formData: FormData): Promise<void> {
  const crateId = String(formData.get('crateId') ?? '');
  const crate = await db.query.crates.findFirst({ where: eq(crates.id, crateId) });
  if (!crate) return;
  const actor = await authorize('crates.manage', { warehouseId: crate.warehouseId });
  const meta = await requestMeta();
  const num = (name: string) => {
    const raw = String(formData.get(name) ?? '').trim();
    return raw ? Number(raw) : null;
  };
  await updateCrate(
    crateId,
    {
      lengthCm: num('lengthCm'),
      widthCm: num('widthCm'),
      heightCm: num('heightCm'),
      weightKg: num('weightKg'),
      note: String(formData.get('note') ?? '').trim() || null,
    },
    { actorId: actor.id, ...meta },
  );
}
