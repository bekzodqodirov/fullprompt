'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/modules/platform/db/client';
import { batches, loadPlans, loadPlanVersions } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { enqueue, JOB_PROCESS_EVENTS, JOB_RECOMPUTE_COSTS } from '@/modules/platform/jobs/boss';
import {
  PlanError,
  recordVerdict,
  submitPlan,
  submitPlanSchema,
  verdictSchema,
} from '@/modules/wms/planning/service';
import { departBatch, finishLoading, ScanError } from '@/modules/wms/scanning/service';
import { z } from 'zod';

export async function submitPlanAction(
  input: unknown,
): Promise<{ ok: boolean; planId?: string; error?: string; detail?: string }> {
  const parsed = submitPlanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const actor = await authorize('plans.manage', { warehouseId: parsed.data.originWarehouseId });
  const meta = await requestMeta();
  try {
    const { plan } = await submitPlan(parsed.data, { actorId: actor.id, ...meta });
    return { ok: true, planId: plan.id };
  } catch (err) {
    if (err instanceof PlanError) return { ok: false, error: err.code, detail: err.detail };
    throw err;
  }
}

export async function recordVerdictAction(
  input: unknown,
): Promise<{ ok: boolean; batchId?: string; error?: string }> {
  const parsed = verdictSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const version = await db.query.loadPlanVersions.findFirst({
    where: eq(loadPlanVersions.id, parsed.data.versionId),
  });
  if (!version) return { ok: false, error: 'version_not_found' };
  const plan = (await db.query.loadPlans.findFirst({ where: eq(loadPlans.id, version.planId) }))!;
  const actor = await authorize('plans.manage', { warehouseId: plan.originWarehouseId });
  const meta = await requestMeta();
  try {
    const result = await recordVerdict(parsed.data, { actorId: actor.id, ...meta });
    await enqueue(JOB_PROCESS_EVENTS, {});
    revalidatePath(`/plans/${plan.id}`);
    return { ok: true, batchId: result.batch?.id };
  } catch (err) {
    if (err instanceof PlanError) return { ok: false, error: err.code };
    throw err;
  }
}

const vehicleSchema = z.object({
  batchId: z.string().uuid(),
  vehiclePlate: z.string().trim().max(20).optional().or(z.literal('')),
  driverName: z.string().trim().max(200).optional().or(z.literal('')),
  driverPhone: z.string().trim().max(50).optional().or(z.literal('')),
});

export interface VehicleFormState {
  ok?: boolean;
  error?: string;
}

export async function saveVehicleAction(
  _prev: VehicleFormState,
  formData: FormData,
): Promise<VehicleFormState> {
  const parsed = vehicleSchema.safeParse({
    batchId: formData.get('batchId'),
    vehiclePlate: formData.get('vehiclePlate'),
    driverName: formData.get('driverName'),
    driverPhone: formData.get('driverPhone'),
  });
  if (!parsed.success) return { error: 'validation' };
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, parsed.data.batchId) });
  if (!batch) return { error: 'not_found' };
  try {
    await authorize('batches.vehicle_info', { warehouseId: batch.originWarehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  await db
    .update(batches)
    .set({
      vehiclePlate: parsed.data.vehiclePlate || null,
      driverName: parsed.data.driverName || null,
      driverPhone: parsed.data.driverPhone || null,
    })
    .where(eq(batches.id, parsed.data.batchId));
  revalidatePath(`/batches/${parsed.data.batchId}`);
  return { ok: true };
}

export async function finishLoadingAction(
  batchId: string,
): Promise<{ ok: boolean; loaded?: number; shortLoaded?: number; error?: string }> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return { ok: false, error: 'batch_not_found' };
  const actor = await authorize('scan.load', { warehouseId: batch.originWarehouseId });
  const meta = await requestMeta();
  try {
    const summary = await finishLoading(batchId, { actorId: actor.id, ...meta });
    revalidatePath(`/batches/${batchId}`);
    return { ok: true, loaded: summary.loaded, shortLoaded: summary.shortLoaded };
  } catch (err) {
    if (err instanceof ScanError) return { ok: false, error: err.code };
    throw err;
  }
}

export async function departBatchAction(
  batchId: string,
): Promise<{ ok: boolean; boxCount?: number; error?: string }> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return { ok: false, error: 'batch_not_found' };
  // Owner's rule: the origin-warehouse loader may send the truck off too
  // (the UI asks for confirmation); closing/arrival stays manager-only.
  let actor;
  try {
    actor = await authorize('batches.depart_close', { warehouseId: batch.originWarehouseId });
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
    actor = await authorize('scan.load', { warehouseId: batch.originWarehouseId });
  }
  const meta = await requestMeta();
  try {
    const result = await departBatch(batchId, { actorId: actor.id, ...meta });
    await enqueue(JOB_PROCESS_EVENTS, {});
    // The departed load is the ground truth for batch-cost shares (spec 6.9).
    await enqueue(JOB_RECOMPUTE_COSTS, { batchId });
    revalidatePath(`/batches/${batchId}`);
    return { ok: true, boxCount: result.boxCount };
  } catch (err) {
    if (err instanceof ScanError) return { ok: false, error: err.code };
    throw err;
  }
}
