'use server';

import { z } from 'zod';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { enqueue, JOB_PROCESS_EVENTS } from '@/modules/platform/jobs/boss';
import {
  acceptFoundBox,
  binCandidate,
  InventoryError,
  reconcileInventory,
  reconcileSchema,
  type FoundBoxSummary,
} from '@/modules/wms/inventory/service';
import { markBoxLost, VoidError } from '@/modules/wms/receipts/service';
import { mayWriteOffBox } from '@/modules/wms/receipts/box-write-off';

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

export interface BinResult {
  ok: boolean;
  error?: string;
  shortCode?: string;
  /** What the operator is about to bin — read before anything is written. */
  found?: BinCandidate;
}

export interface BinCandidate {
  boxId: string;
  shortCode: string;
  clientCode: string | null;
  marking: string | null;
  letter: string | null;
  product: string;
}

const binSchema = z.object({
  warehouseId: z.string().uuid(),
  code: z.string().trim().min(4).max(20),
});
const binConfirmSchema = binSchema.extend({
  boxId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
});

/**
 * Step one of the bin scan: what IS this code, and may it be binned here?
 *
 * Nothing is written. The operator reads the client code and the goods on
 * screen before the write-off, because a mis-scan of the neighbouring carton
 * must cost a glance rather than a correction.
 */
export async function binLookupAction(input: unknown): Promise<BinResult> {
  const parsed = binSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  let actor;
  try {
    actor = await authorize('receipts.void', { warehouseId: parsed.data.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  if (!mayWriteOffBox(actor)) return { ok: false, error: 'forbidden' };
  try {
    const found = await binCandidate(parsed.data);
    return { ok: true, found };
  } catch (err) {
    if (err instanceof InventoryError) return { ok: false, error: err.code };
    throw err;
  }
}

/** Step two: the reason is typed, the carton is in the bin. */
export async function binConfirmAction(input: unknown): Promise<BinResult> {
  const parsed = binConfirmSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  let actor;
  try {
    actor = await authorize('receipts.void', { warehouseId: parsed.data.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  if (!mayWriteOffBox(actor)) return { ok: false, error: 'forbidden' };
  const meta = await requestMeta();
  try {
    // Re-resolved rather than trusted: the posted boxId is a forged post
    // (#514), and the code is what the person actually scanned.
    const found = await binCandidate(parsed.data);
    if (found.boxId !== parsed.data.boxId) return { ok: false, error: 'code_changed' };
    const res = await markBoxLost(
      {
        boxId: found.boxId,
        reason: parsed.data.reason,
        atWarehouseId: parsed.data.warehouseId,
      },
      { actorId: actor.id, ...meta },
    );
    await enqueue(JOB_PROCESS_EVENTS, {});
    return { ok: true, shortCode: res.shortCode };
  } catch (err) {
    if (err instanceof InventoryError) return { ok: false, error: err.code };
    if (err instanceof VoidError) return { ok: false, error: err.code };
    throw err;
  }
}
