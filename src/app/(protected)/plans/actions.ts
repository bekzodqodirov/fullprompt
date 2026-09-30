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
  cancelPlan,
  recordVerdict,
  submitPlan,
  submitPlanSchema,
  verdictSchema,
} from '@/modules/wms/planning/service';
import { departBatch, finishLoading, ScanError } from '@/modules/wms/scanning/service';
import { cancelBatch } from '@/modules/wms/scanning/unload';
import { mayCountMove } from '@/modules/wms/scanning/count-door';
import { authorizeOnBatch } from '@/modules/wms/batches/batch-authorize';
import { BATCH_TABS, batchTabHref } from '@/modules/wms/batches/card-door';
import { RenameError, renameBatch } from '@/modules/wms/batches/rename';
import { isBusyError } from '@/modules/platform/db/errors';
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

/**
 * «Yuklash tugadi». Since 0112 it can refuse over a QR-siz lot nobody counted
 * (`qrless_uncounted`, naming the lots) — and then says whether THIS person
 * may finish anyway: dropping those lots back to the shelf is the count
 * door's call at the origin (the admin and the logist), never the loader's.
 * A refusal is an answer, never an AuthError thrown into an onClick.
 */
export async function finishLoadingAction(
  batchId: string,
  opts: { dropQrless?: boolean } = {},
): Promise<{
  ok: boolean;
  loaded?: number;
  shortLoaded?: number;
  error?: string;
  lots?: string[];
  canDrop?: boolean;
}> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return { ok: false, error: 'batch_not_found' };
  let actor;
  try {
    actor = await authorize('scan.load', { warehouseId: batch.originWarehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  const canDrop = mayCountMove(actor, batch.originWarehouseId);
  if (opts.dropQrless && !canDrop) return { ok: false, error: 'forbidden' };
  const meta = await requestMeta();
  try {
    const summary = await finishLoading(
      batchId,
      { actorId: actor.id, ...meta },
      { dropQrless: opts.dropQrless === true },
    );
    revalidatePath(`/batches/${batchId}`);
    return { ok: true, loaded: summary.loaded, shortLoaded: summary.shortLoaded };
  } catch (err) {
    if (err instanceof ScanError) {
      return { ok: false, error: err.code, lots: err.detail?.lots, canDrop };
    }
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

export interface BatchCodeFormState {
  ok?: boolean;
  error?: string;
  detail?: string;
  code?: string;
  changed?: boolean;
}

/**
 * Rename a truck — before departure and, since the owner's 1a (2026-09-30),
 * on the road until unloading finishes (`wms/batches/rename.ts`, which
 * reverses #122).
 *
 * The door is asked here AND again by the service on the row it locks:
 * `authorizeOnBatch` is the permission first and then the truck card's own
 * two-ends door, and the service re-asks the stage's rule (origin before
 * departure, either end on the road, nobody once finished). `seen` is what
 * the presser's screen showed; a page rendered before this deploy posts none
 * and is answered `batch_changed`, which refreshes it — never a guess.
 */
export async function renameBatchAction(
  _prev: BatchCodeFormState,
  formData: FormData,
): Promise<BatchCodeFormState> {
  const batchId = String(formData.get('batchId') ?? '');
  const code = String(formData.get('code') ?? '');
  const reason = String(formData.get('reason') ?? '');
  const seenCode = formData.get('seenCode');
  const seenStage = formData.get('seenStage');
  if (typeof seenCode !== 'string' || (seenStage !== 'loading' && seenStage !== 'road')) {
    return { error: 'batch_changed' };
  }
  let door;
  try {
    door = await authorizeOnBatch('plans.manage', batchId);
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  if (!door) return { error: 'not_found' };
  const meta = await requestMeta();
  try {
    const result = await renameBatch(
      { batchId, code, reason, seen: { code: seenCode, stage: seenStage } },
      door.actor,
      { actorId: door.actor.id, ...meta },
    );
    // Every tab of the card carries the header, and four lists print the code.
    for (const tab of BATCH_TABS) revalidatePath(batchTabHref(batchId, tab));
    revalidatePath('/batches');
    revalidatePath('/transit');
    revalidatePath('/trucks');
    revalidatePath('/map');
    return { ok: true, code: result.batch.code, changed: result.changed };
  } catch (err) {
    if (err instanceof RenameError) return { error: err.code, detail: err.detail };
    if (isBusyError(err)) return { error: 'busy' };
    throw err;
  }
}

/**
 * Cancel a batch that never left (owner: test batches created in production
 * during development that there was no way to remove).
 *
 * Gated on `batches.depart_close` and NOT on the loader's `scan.load` — unlike
 * departure, which the origin loader may do because he is the one standing at
 * the truck. Giving the cargo back and retiring the trip is a manager's call.
 */
export async function cancelBatchAction(
  batchId: string,
  reason: string,
): Promise<{ ok: boolean; released?: number; error?: string }> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return { ok: false, error: 'batch_not_found' };
  const actor = await authorize('batches.depart_close', { warehouseId: batch.originWarehouseId });
  const meta = await requestMeta();
  try {
    const result = await cancelBatch(batchId, reason, { actorId: actor.id, ...meta });
    revalidatePath(`/batches/${batchId}`);
    revalidatePath('/batches');
    return { ok: true, released: result.boxesReleased };
  } catch (err) {
    if (err instanceof ScanError) return { ok: false, error: err.code };
    throw err;
  }
}

/** Retire a plan that never became a batch. Same permission that submits one. */
export async function cancelPlanAction(
  planId: string,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  const plan = await db.query.loadPlans.findFirst({ where: eq(loadPlans.id, planId) });
  if (!plan) return { ok: false, error: 'plan_not_found' };
  const actor = await authorize('plans.manage', { warehouseId: plan.originWarehouseId });
  const meta = await requestMeta();
  try {
    await cancelPlan(planId, reason, { actorId: actor.id, ...meta });
    revalidatePath(`/plans/${planId}`);
    revalidatePath('/plans');
    return { ok: true };
  } catch (err) {
    if (err instanceof PlanError) return { ok: false, error: err.code };
    throw err;
  }
}
