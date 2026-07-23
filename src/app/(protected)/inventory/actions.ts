'use server';

import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { enqueue, JOB_PROCESS_EVENTS } from '@/modules/platform/jobs/boss';
import {
  InventoryError,
  reconcileInventory,
  reconcileSchema,
} from '@/modules/wms/inventory/service';

export interface ReconcileResult {
  ok: boolean;
  error?: string;
  moved?: string[];
  lost?: string[];
  skipped?: string[];
}

export async function reconcileInventoryAction(input: unknown): Promise<ReconcileResult> {
  const parsed = reconcileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };

  let actor;
  try {
    actor = await authorize('scan.load', { warehouseId: parsed.data.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    const summary = await reconcileInventory(
      parsed.data,
      // Marking boxes lost stays a manager decision (owner's answer):
      // requires the receipts.void grant the operators don't have.
      { canMarkLost: actor.permissions.has('receipts.void') },
      { actorId: actor.id, ...meta },
    );
    await enqueue(JOB_PROCESS_EVENTS, {});
    return { ok: true, moved: summary.moved, lost: summary.lost, skipped: summary.skipped };
  } catch (err) {
    if (err instanceof InventoryError) return { ok: false, error: err.code };
    throw err;
  }
}
