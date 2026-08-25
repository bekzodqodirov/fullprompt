'use server';

import { z } from 'zod';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { enqueue, JOB_PROCESS_EVENTS } from '@/modules/platform/jobs/boss';
import {
  acceptFoundBox,
  InventoryError,
  reconcileInventory,
  reconcileSchema,
  type FoundBoxSummary,
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

export interface AcceptFoundResult {
  ok: boolean;
  error?: string;
  found?: FoundBoxSummary;
}

/**
 * One box found standing here while the record says elsewhere (owner,
 * 2026-08-25) — the stocktake's found-here rule for a single scan. Same door
 * as the stocktake: the loader's own permission at THIS warehouse.
 */
export async function acceptFoundAction(input: unknown): Promise<AcceptFoundResult> {
  const parsed = acceptFoundSchema.safeParse(input);
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
    const found = await acceptFoundBox(parsed.data, { actorId: actor.id, ...meta });
    return { ok: true, found };
  } catch (err) {
    if (err instanceof InventoryError) return { ok: false, error: err.code };
    throw err;
  }
}

const acceptFoundSchema = z.object({
  warehouseId: z.string().uuid(),
  code: z.string().trim().min(4).max(20),
});
