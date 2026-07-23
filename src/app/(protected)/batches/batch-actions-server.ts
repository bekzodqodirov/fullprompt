'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/modules/platform/db/client';
import { batches, boxes } from '@/modules/platform/db/schema';
import { authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { enqueue, JOB_PROCESS_EVENTS } from '@/modules/platform/jobs/boss';
import { ScanError } from '@/modules/wms/scanning/service';
import {
  closeBatch,
  finishUnload,
  resolveMissing,
  resolveMissingSchema,
} from '@/modules/wms/scanning/unload';

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
