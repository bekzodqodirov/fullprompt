'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { batches, boxes, driverDevices } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { enqueue, JOB_PROCESS_EVENTS } from '@/modules/platform/jobs/boss';
import { authorizeOnBatch } from '@/modules/wms/batches/batch-authorize';
import { removeLoadedCode, ScanError } from '@/modules/wms/scanning/service';
import {
  closeBatch,
  finishUnload,
  resolveMissing,
  resolveMissingLot,
  resolveMissingLotSchema,
  resolveMissingSchema,
  unloadRemaining,
} from '@/modules/wms/scanning/unload';
import {
  countAcceptCrate,
  countAcceptCrateSchema,
  countAcceptLot,
  countAcceptSchema,
  CountError,
  type CountAcceptRefusal,
  type CountAcceptResult,
} from '@/modules/wms/scanning/count-accept';
import { countDoorFor } from '@/modules/wms/scanning/count-door';
import { isBusyError } from '@/modules/platform/db/errors';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import type { CheckpointActionState } from '@/modules/wms/tracking/checkpoint';

/**
 * Accept the whole remaining manifest at the destination without scanning.
 *
 * Built because finishing was once the only one-tap action and that one
 * declares the cargo lost. The owner has now asked for it to leave the
 * operators («hammasini qabul qilib olish degan knobkani skladchilardan olib
 * tashla») — he wants the cartons actually scanned — so BOTH shortcuts move to
 * the manager together: this one, and finishing with boxes still outstanding
 * (`finishUnloadAction`). Moving only this one would leave the operator the
 * lossy button and take away the safe one, which is the inversion the button
 * was built to fix.
 */
export async function unloadRemainingAction(
  batchId: string,
): Promise<{ ok: boolean; accepted?: number; skippedCounted?: number; error?: string }> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return { ok: false, error: 'batch_not_found' };
  let actor;
  try {
    actor = await authorize('receipts.void', { warehouseId: batch.destWarehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    const result = await unloadRemaining(batchId, { actorId: actor.id, ...meta });
    await enqueue(JOB_PROCESS_EVENTS, {});
    revalidatePath(`/batches/${batchId}`);
    return { ok: true, accepted: result.accepted, skippedCounted: result.skippedCounted };
  } catch (err) {
    if (err instanceof ScanError) return { ok: false, error: err.code };
    throw err;
  }
}

export type CountAcceptActionResult =
  | { ok: true; result: CountAcceptResult }
  | { ok: false; error: CountAcceptRefusal | 'validation'; detail?: Record<string, number | string> };

/**
 * «Sanab qabul» (0112): the office's count of one lot off a truck. The count
 * door at the DESTINATION opens it; the origin's door rides along for
 * cartons beyond the truck, which come off the origin's books — the service
 * asks both again (#531). Wrapped like every action here: an AuthError out of
 * an async onClick has no boundary and reaches the person as nothing.
 */
export async function countAcceptLotAction(input: unknown): Promise<CountAcceptActionResult> {
  const parsed = countAcceptSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, parsed.data.batchId) });
  if (!batch) return { ok: false, error: 'batch_not_found' };
  let actor;
  try {
    actor = await authorize('plans.manage', { warehouseId: batch.destWarehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  const dest = countDoorFor(actor, batch.destWarehouseId);
  if (!dest) return { ok: false, error: 'forbidden' };
  const origin = countDoorFor(actor, batch.originWarehouseId);
  const meta = await requestMeta();
  try {
    const result = await countAcceptLot(parsed.data, { actorId: actor.id, ...meta }, { dest, origin });
    if (!result.replay) await enqueue(JOB_PROCESS_EVENTS, {});
    revalidatePath(`/batches/${batch.id}`);
    return { ok: true, result };
  } catch (err) {
    if (err instanceof CountError) return { ok: false, error: err.code, detail: err.detail };
    if (isBusyError(err)) return { ok: false, error: 'busy_retry' };
    if (err instanceof ScanError && err.code === 'batch_not_unloading') {
      return { ok: false, error: 'batch_not_unloading' };
    }
    throw err;
  }
}

/** A crate (a pallet) accepted whole — one place, through the crate branch (Q10 d). */
export async function countAcceptCrateAction(
  input: unknown,
): Promise<
  | { ok: true; landed: number; notArrived: string[]; replay: boolean }
  | { ok: false; error: CountAcceptRefusal | 'validation' }
> {
  const parsed = countAcceptCrateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, parsed.data.batchId) });
  if (!batch) return { ok: false, error: 'batch_not_found' };
  let actor;
  try {
    actor = await authorize('plans.manage', { warehouseId: batch.destWarehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  const dest = countDoorFor(actor, batch.destWarehouseId);
  if (!dest) return { ok: false, error: 'forbidden' };
  const meta = await requestMeta();
  try {
    const res = await countAcceptCrate(parsed.data, { actorId: actor.id, ...meta }, { dest });
    if (!res.replay) await enqueue(JOB_PROCESS_EVENTS, {});
    revalidatePath(`/batches/${batch.id}`);
    return { ok: true, landed: res.landed, notArrived: res.notArrived, replay: res.replay };
  } catch (err) {
    if (err instanceof CountError) return { ok: false, error: err.code };
    if (isBusyError(err)) return { ok: false, error: 'busy_retry' };
    throw err;
  }
}

/**
 * N of one lot's missing cartons at once (0112, decision 22). A typed number
 * moves cargo with no per-carton witness, so it is behind the COUNT door at
 * the destination — the per-box buttons beside it keep `receipts.void`.
 */
export async function resolveMissingLotAction(
  input: unknown,
): Promise<{ ok: boolean; resolved?: number; error?: string }> {
  const parsed = resolveMissingLotSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, parsed.data.batchId) });
  if (!batch) return { ok: false, error: 'batch_not_found' };
  let actor;
  try {
    actor = await authorize('plans.manage', { warehouseId: batch.destWarehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    const res = await resolveMissingLot(
      parsed.data,
      { actorId: actor.id, ...meta },
      countDoorFor(actor, batch.destWarehouseId),
    );
    revalidatePath(`/batches/${batch.id}`);
    return { ok: true, resolved: res.resolved };
  } catch (err) {
    if (err instanceof ScanError) return { ok: false, error: err.code };
    // A count press holding the same cartons: «try again», never a white
    // page (review ui-5, the count doors' own mapping).
    if (isBusyError(err)) return { ok: false, error: 'busy_retry' };
    throw err;
  }
}

/**
 * Close the unload.
 *
 * Two different acts behind one button: with everything scanned it is
 * bookkeeping, and with cartons outstanding it DECLARES THEM LOST — every one
 * flagged `missing_in_transit`, which then refuses the client's handover. So
 * the gate is asked twice: the plain finish stays the unloader's, and
 * finishing over remaining boxes needs the manager grant, exactly like the
 * accept-all it sits beside. The SERVICE refuses too (#531): a screen that
 * hides a button is not a door.
 */
export async function finishUnloadAction(
  batchId: string,
): Promise<{ ok: boolean; missing?: string[]; error?: string }> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return { ok: false, error: 'batch_not_found' };
  let actor;
  try {
    actor = await authorize('scan.unload', { warehouseId: batch.destWarehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    const result = await finishUnload(batchId, { actorId: actor.id, ...meta }, {
      mayCloseWithMissing: actor.permissions.has('receipts.void'),
    });
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
  // Manager-level (DECISIONS #43 proxy). Wrapped like every other action in
  // this file: an AuthError thrown from an async onClick has no boundary and
  // reaches the operator as nothing at all.
  let actor;
  try {
    actor = await authorize('receipts.void', { warehouseId: batch.destWarehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
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

/**
 * VED "sent to agent" flag (spec 6.6).
 *
 * Judged at the truck's two ends by `authorizeOnBatch` — the card's own door —
 * like every action here that changes one truck. It was `authorize(code, {})`,
 * which checks no warehouse at all, so a scoped holder of the permission could
 * press it on any truck in the company (docs/CARD-TABS.md, «Holes found on the
 * way»).
 */
export async function setSentToAgentAction(formData: FormData): Promise<void> {
  const batchId = String(formData.get('batchId') ?? '');
  const door = await authorizeOnBatch('ved.docs', batchId);
  if (!door) return;
  const { actor, batch } = door;
  const meta = await requestMeta();
  await db
    .update(batches)
    .set({ sentToAgentAt: batch.sentToAgentAt ? null : tashkentDay() })
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
  const door = await authorizeOnBatch('ved.docs', batchId);
  if (!door) return;
  const { actor, batch } = door;
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
 *
 * The truck's door says nothing about the receipt id in the same post, so the
 * prixod must also be one of THIS truck's rows — the very list the panel
 * draws (`batchCustomsRows`), never a membership rule restated here. Without
 * it, any truck the person may open was a key to every prixod in the company.
 */
export async function setReceiptCustomsAction(
  batchId: string,
  receiptId: string,
  value: string,
): Promise<void> {
  const door = await authorizeOnBatch('ved.docs', batchId);
  if (!door) return;
  const { actor } = door;
  const meta = await requestMeta();
  const { batchCustomsRows, setReceiptCustoms } = await import('@/modules/wms/partners/customs');
  const rows = await batchCustomsRows(batchId);
  if (!rows.some((row) => row.receiptId === receiptId)) {
    throw new AuthError('Receipt is not on this batch', 'forbidden');
  }
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
  const door = await authorizeOnBatch('ved.docs', batchId);
  if (!door) return;
  const { actor, batch } = door;
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
 * «Partiya» — whether this truck is one «Partiya foydasi» reads (0107). The
 * owner's own words: the admin or the accountant marks it, so the gate is
 * `finance.reports`, the grant the profit screen itself asks. Pressing again
 * clears it; an explicit value from the form, not a toggle of what the row
 * held, so a double press or a stale tab cannot flip it back.
 */
export async function setProfitTrackedAction(formData: FormData): Promise<void> {
  const batchId = String(formData.get('batchId') ?? '');
  const next = formData.get('tracked') === '1';
  const door = await authorizeOnBatch('finance.reports', batchId);
  if (!door) return;
  const { actor, batch } = door;
  if (batch.profitTracked === next) return;
  const meta = await requestMeta();
  await db.update(batches).set({ profitTracked: next }).where(eq(batches.id, batchId));
  const { writeAudit } = await import('@/modules/platform/audit/service');
  await writeAudit(db, { actorId: actor.id, ...meta, warehouseId: batch.destWarehouseId }, {
    entityType: 'batch',
    entityId: batchId,
    action: 'update',
    before: { profitTracked: batch.profitTracked },
    after: { profitTracked: next },
  });
  revalidatePath(`/batches/${batchId}`);
  revalidatePath('/accounting/profit');
}

/**
 * Manual position pin for the tracking map ("still at the border") — the
 * simulation re-anchors from this moment. Tapping the active pin clears it.
 *
 * The writing is `setTrackingCheckpoint`'s (tracking/checkpoint.ts), which
 * asks the truck's ROAD which pins it carries; this door answers its refusal
 * in words instead of returning quietly, because a press that silently does
 * nothing reads as a press that worked (`CheckpointButtons` prints it).
 */
export async function setTrackingCheckpointAction(
  _prev: CheckpointActionState,
  formData: FormData,
): Promise<CheckpointActionState> {
  const batchId = String(formData.get('batchId') ?? '');
  const key = String(formData.get('key') ?? '');
  let door: Awaited<ReturnType<typeof authorizeOnBatch>>;
  try {
    door = await authorizeOnBatch('batches.vehicle_info', batchId);
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  // A truck that is not there is not on the road — words, not a white page.
  if (!door) return { error: 'not_in_transit' };
  const meta = await requestMeta();
  const { setTrackingCheckpoint, CheckpointError } = await import('@/modules/wms/tracking/checkpoint');
  try {
    await setTrackingCheckpoint(door.actor, batchId, key, meta);
  } catch (err) {
    if (err instanceof CheckpointError) return { error: err.code };
    throw err;
  }
  // The pin moves the header's ETA on every tab of the card, not only this one.
  revalidatePath(`/batches/${batchId}`, 'layout');
  revalidatePath('/map');
  return { ok: true };
}

/**
 * Driver tracking (owner's flow): at loading the warehouse worker installs
 * the app on the driver's phone and types this code once.
 */
export async function createDriverDeviceAction(formData: FormData): Promise<void> {
  const batchId = String(formData.get('batchId') ?? '');
  const label = String(formData.get('label') ?? '');
  const door = await authorizeOnBatch('batches.vehicle_info', batchId);
  if (!door) return;
  const { actor } = door;
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

/**
 * Revoke a paired phone. The truck's door is asked about the truck in the
 * post, so the phone must be THAT truck's — otherwise opening one card was a
 * key to every driver's phone in the fleet. A device id that names nothing
 * goes on to the service, whose own answer to it is a quiet no-op.
 */
export async function revokeDriverDeviceAction(formData: FormData): Promise<void> {
  const deviceId = String(formData.get('deviceId') ?? '');
  const batchId = String(formData.get('batchId') ?? '');
  if (!deviceId) return;
  const door = await authorizeOnBatch('batches.vehicle_info', batchId);
  if (!door) return;
  const { actor, batch } = door;
  const device = await db.query.driverDevices.findFirst({
    where: eq(driverDevices.id, deviceId),
    columns: { batchId: true },
  });
  if (device && device.batchId !== batch.id) {
    throw new AuthError('Device is not on this batch', 'forbidden');
  }
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
