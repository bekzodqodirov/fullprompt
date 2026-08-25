'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { batches, boxes } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { enqueue, JOB_PROCESS_EVENTS } from '@/modules/platform/jobs/boss';
import { removeLoadedCode, ScanError } from '@/modules/wms/scanning/service';
import {
  closeBatch,
  finishUnload,
  resolveMissing,
  resolveMissingSchema,
  unloadRemaining,
} from '@/modules/wms/scanning/unload';

/**
 * Accept the whole remaining manifest at the destination without scanning
 * (owner: the truck is here, the boxes are here — finishing the unload should
 * not be the only one-tap action, because that one declares them lost).
 */
export async function unloadRemainingAction(
  batchId: string,
): Promise<{ ok: boolean; accepted?: number; error?: string }> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return { ok: false, error: 'batch_not_found' };
  const actor = await authorize('scan.unload', { warehouseId: batch.destWarehouseId });
  const meta = await requestMeta();
  try {
    const result = await unloadRemaining(batchId, { actorId: actor.id, ...meta });
    await enqueue(JOB_PROCESS_EVENTS, {});
    revalidatePath(`/batches/${batchId}`);
    return { ok: true, accepted: result.accepted };
  } catch (err) {
    if (err instanceof ScanError) return { ok: false, error: err.code };
    throw err;
  }
}

export async function finishUnloadAction(
  batchId: string,
): Promise<{ ok: boolean; missing?: string[]; error?: string }> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return { ok: false, error: 'batch_not_found' };
  const actor = await authorize('scan.unload', { warehouseId: batch.destWarehouseId });
  const meta = await requestMeta();
  try {
    const result = await finishUnload(batchId, { actorId: actor.id, ...meta });
    await enqueue(JOB_PROCESS_EVENTS, {});
    revalidatePath(`/batches/${batchId}`);
    return { ok: true, missing: result.missing };
  } catch (err) {
    if (err instanceof ScanError) return { ok: false, error: err.code };
    throw err;
  }
}

export async function resolveMissingAction(
  input: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = resolveMissingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const box = await db.query.boxes.findFirst({ where: eq(boxes.id, parsed.data.boxId) });
  if (!box?.currentBatchId) return { ok: false, error: 'not_missing' };
  const batch = (await db.query.batches.findFirst({ where: eq(batches.id, box.currentBatchId) }))!;
  // Manager-level (DECISIONS #43 proxy).
  const actor = await authorize('receipts.void', { warehouseId: batch.destWarehouseId });
  const meta = await requestMeta();
  try {
    await resolveMissing(parsed.data, { actorId: actor.id, ...meta });
    revalidatePath(`/batches/${batch.id}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof ScanError) return { ok: false, error: err.code };
    throw err;
  }
}

/**
 * Take a scanned box/crate back off a still-loading truck (owner, 2026-08-25,
 * his answer B: off the plan entirely, back to the shelf). Gated exactly as
 * the load scan itself — the loader at the ORIGIN, standing at the truck.
 */
export async function removeLoadedAction(
  input: unknown,
): Promise<{ ok: boolean; removed?: string[]; error?: string }> {
  const parsed = removeLoadedSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, parsed.data.batchId) });
  if (!batch) return { ok: false, error: 'batch_not_found' };
  let actor;
  try {
    actor = await authorize('scan.load', { warehouseId: batch.originWarehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    const res = await removeLoadedCode(parsed.data.batchId, parsed.data.code, {
      actorId: actor.id,
      ...meta,
    });
    revalidatePath(`/batches/${batch.id}`);
    return { ok: true, removed: res.removed };
  } catch (err) {
    if (err instanceof ScanError) return { ok: false, error: err.code };
    throw err;
  }
}

const removeLoadedSchema = z.object({
  batchId: z.string().uuid(),
  code: z.string().trim().min(3).max(40),
});

/** Quick batch (spec 6.6): internal transfer with no plan/approval loop. */
export async function createQuickBatchAction(
  formData: FormData,
): Promise<void> {
  const originId = String(formData.get('originId') ?? '');
  const destId = String(formData.get('destId') ?? '');
  if (!originId || !destId || originId === destId) return;
  const actor = await authorize('batches.depart_close', { warehouseId: originId });
  const meta = await requestMeta();
  const { nextBatchCode } = await import('@/modules/wms/codes');
  const { warehouses } = await import('@/modules/platform/db/schema');
  const { writeAudit } = await import('@/modules/platform/audit/service');
  const { mintBatchPairCode } = await import('@/modules/wms/tracking/devices');
  const { redirect } = await import('next/navigation');
  const [origin, dest] = await Promise.all([
    db.query.warehouses.findFirst({ where: eq(warehouses.id, originId) }),
    db.query.warehouses.findFirst({ where: eq(warehouses.id, destId) }),
  ]);
  if (!origin || !dest) return;
  // The screen hides the button for a warehouse that does not allow an
  // unplanned truck; the service refuses it too, because a hidden control is
  // not a rule — a hand-posted form would otherwise still create one.
  if (!origin.allowsQuickBatch) return;
  const batch = await db.transaction(async (tx) => {
    const code = await nextBatchCode(tx, origin);
    const [row] = await tx
      .insert(batches)
      .values({
        code,
        originWarehouseId: originId,
        destWarehouseId: destId,
        type: ['customs', 'distribution'].includes(dest.type) ? 'distribution' : 'transfer',
        status: 'forming',
        createdBy: actor.id,
      })
      .returning();
    await mintBatchPairCode(tx, row!.id, actor.id);
    await writeAudit(tx, { actorId: actor.id, ...meta, warehouseId: originId }, {
      entityType: 'batch',
      entityId: row!.id,
      action: 'create',
      after: { code, quick: true },
    });
    return row!;
  });
  redirect(`/batches/${batch.id}`);
}

/** VED "sent to agent" flag (spec 6.6). */
export async function setSentToAgentAction(formData: FormData): Promise<void> {
  const batchId = String(formData.get('batchId') ?? '');
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return;
  const actor = await authorize('ved.docs', {});
  const meta = await requestMeta();
  await db
    .update(batches)
    .set({ sentToAgentAt: batch.sentToAgentAt ? null : new Date().toISOString().slice(0, 10) })
    .where(eq(batches.id, batchId));
  const { writeAudit } = await import('@/modules/platform/audit/service');
  await writeAudit(db, { actorId: actor.id, ...meta, warehouseId: batch.originWarehouseId }, {
    entityType: 'batch',
    entityId: batchId,
    action: 'update',
    after: { sentToAgent: !batch.sentToAgentAt },
  });
  revalidatePath(`/batches/${batchId}`);
}

/**
 * Which firm cleared this truck (round 39). `'client'` is not a partner id
 * but the owner's third case — the client cleared it through their own firm —
 * and it is stored as its own flag rather than as a fake counterparty,
 * because there is no account to keep for a firm we never pay.
 */
export async function setCustomsFirmAction(batchId: string, value: string): Promise<void> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return;
  const actor = await authorize('ved.docs', {});
  const meta = await requestMeta();
  const byClient = value === 'client';
  await db
    .update(batches)
    .set({
      customsByClient: byClient,
      customsPartnerId: byClient || !value ? null : value,
    })
    .where(eq(batches.id, batchId));
  const { writeAudit } = await import('@/modules/platform/audit/service');
  await writeAudit(db, { actorId: actor.id, ...meta, warehouseId: batch.originWarehouseId }, {
    entityType: 'batch',
    entityId: batchId,
    action: 'update',
    before: { customsPartnerId: batch.customsPartnerId, customsByClient: batch.customsByClient },
    after: { customsPartnerId: byClient || !value ? null : value, customsByClient: byClient },
  });
  revalidatePath(`/batches/${batchId}`);
}

/**
 * One prixod's own customs answer (round 39 follow-up). Same gate as the
 * truck-level choice: this is VED paperwork, not warehouse work.
 */
export async function setReceiptCustomsAction(
  batchId: string,
  receiptId: string,
  value: string,
): Promise<void> {
  const actor = await authorize('ved.docs', {});
  const meta = await requestMeta();
  const { setReceiptCustoms } = await import('@/modules/wms/partners/customs');
  await setReceiptCustoms(receiptId, value, { actorId: actor.id, ...meta });
  revalidatePath(`/batches/${batchId}`);
  revalidatePath(`/receipts/${receiptId}`);
}

/**
 * «Rastamojka tugadi» — the owner's answer to the cabinet's one folded rung.
 *
 * The customer's timeline had «ozbga kirdi» and «rastamojka» as ONE stage,
 * because nothing recorded when a declaration cleared and a stage that only
 * advances when somebody remembers is a stage that lies. He chose to add the
 * remembering: «ha rastamojka tugadi tugmasini qo'sh».
 *
 * `ved.docs`, because this is the customs manager's fact and not the
 * warehouse's — the same gate the firm picker beside it uses. Pressing again
 * clears it, exactly as the position pins do: the person who marked the wrong
 * truck must be able to say so, and NULL reads honestly as «nobody has said».
 */
export async function setCustomsClearedAction(formData: FormData): Promise<void> {
  const batchId = String(formData.get('batchId') ?? '');
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return;
  const actor = await authorize('ved.docs', {});
  const meta = await requestMeta();
  const next = batch.customsClearedAt ? null : new Date();
  await db.update(batches).set({ customsClearedAt: next }).where(eq(batches.id, batchId));
  const { writeAudit } = await import('@/modules/platform/audit/service');
  await writeAudit(db, { actorId: actor.id, ...meta, warehouseId: batch.destWarehouseId }, {
    entityType: 'batch',
    entityId: batchId,
    action: 'update',
    before: { customsClearedAt: batch.customsClearedAt },
    after: { customsClearedAt: next },
  });
  revalidatePath(`/batches/${batchId}`);
}

/**
 * Manual position pin for the tracking map ("still at the border") — the
 * simulation re-anchors from this moment. Tapping the active pin clears it.
 */
export async function setTrackingCheckpointAction(formData: FormData): Promise<void> {
  const batchId = String(formData.get('batchId') ?? '');
  const key = String(formData.get('key') ?? '');
  if (!['at_border', 'in_kg', 'in_uz'].includes(key)) return;
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch || batch.status !== 'in_transit') return;
  const actor = await authorize('batches.vehicle_info', {});
  const meta = await requestMeta();
  const current = batch.trackingCheckpoint as { key?: string } | null;
  const next = current?.key === key ? null : { key, at: new Date().toISOString() };
  await db.update(batches).set({ trackingCheckpoint: next }).where(eq(batches.id, batchId));
  const { writeAudit } = await import('@/modules/platform/audit/service');
  await writeAudit(db, { actorId: actor.id, ...meta, warehouseId: batch.originWarehouseId }, {
    entityType: 'batch',
    entityId: batchId,
    action: 'update',
    after: { trackingCheckpoint: next },
  });
  revalidatePath(`/batches/${batchId}`);
  revalidatePath('/map');
}

/**
 * Driver tracking (owner's flow): at loading the warehouse worker installs
 * the app on the driver's phone and types this code once.
 */
export async function createDriverDeviceAction(formData: FormData): Promise<void> {
  const batchId = String(formData.get('batchId') ?? '');
  const label = String(formData.get('label') ?? '');
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return;
  const actor = await authorize('batches.vehicle_info', {});
  const meta = await requestMeta();
  const { createDriverDevice, TrackingError } = await import('@/modules/wms/tracking/devices');
  try {
    await createDriverDevice({ batchId, label }, { actorId: actor.id, ...meta });
  } catch (err) {
    if (err instanceof TrackingError) return;
    throw err;
  }
  revalidatePath(`/batches/${batchId}`);
}

export async function revokeDriverDeviceAction(formData: FormData): Promise<void> {
  const deviceId = String(formData.get('deviceId') ?? '');
  const batchId = String(formData.get('batchId') ?? '');
  if (!deviceId) return;
  const actor = await authorize('batches.vehicle_info', {});
  const meta = await requestMeta();
  const { revokeDriverDevice } = await import('@/modules/wms/tracking/devices');
  await revokeDriverDevice(deviceId, { actorId: actor.id, ...meta });
  revalidatePath(`/batches/${batchId}`);
}

export async function closeBatchAction(batchId: string): Promise<{ ok: boolean; error?: string }> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return { ok: false, error: 'batch_not_found' };
  const actor = await authorize('batches.depart_close', { warehouseId: batch.destWarehouseId });
  const meta = await requestMeta();
  try {
    await closeBatch(batchId, { actorId: actor.id, ...meta });
    revalidatePath(`/batches/${batchId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof ScanError) return { ok: false, error: err.code };
    throw err;
  }
}
