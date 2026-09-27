'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/modules/platform/db/client';
import { batches } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { enqueue, JOB_PROCESS_EVENTS } from '@/modules/platform/jobs/boss';
import { isBusyError } from '@/modules/platform/db/errors';
import { countDoorFor } from '@/modules/wms/scanning/count-door';
import {
  CountError,
  countCrateSchema,
  countLoadCrate,
  countLoadLot,
  countLoadSchema,
  type CountCrateResult,
  type CountErrorDetail,
  type CountLoadErrorCode,
  type CountLoadResult,
} from '@/modules/wms/scanning/count-load';

/*
 * «Sanab yuklash» — the batch card's count door (0112, Q3). Online only and
 * never on the operator's phone: an office count must not sit in a queue.
 *
 * The shape is `unloadRemainingAction`'s: a refusal the screen can put into
 * words, and never a thrown AuthError into an onClick with no boundary. The
 * gate is asked at the truck's ORIGIN (`plans.manage` there — exactly the
 * admin and the logist on the seed), and the service asks the branded door
 * again, because a screen that hides a button is not a door (#531).
 */

export type CountActionError = CountLoadErrorCode | 'bad_target' | 'busy_retry';

export type CountLoadActionResult =
  | ({ ok: true } & CountLoadResult)
  | ({ ok: false; error: CountActionError } & CountErrorDetail);

export type CountCrateActionResult =
  | ({ ok: true } & CountCrateResult)
  | ({ ok: false; error: CountActionError } & CountErrorDetail);

/** The truck, and a door at its origin for the person asking — or a refusal. */
async function doorFor(batchId: string) {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return { ok: false as const, error: 'batch_not_found' as const };
  let actor;
  try {
    actor = await authorize('plans.manage', { warehouseId: batch.originWarehouseId });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false as const, error: 'forbidden' as const };
    throw err;
  }
  const door = countDoorFor(actor, batch.originWarehouseId);
  if (!door) return { ok: false as const, error: 'forbidden' as const };
  return { ok: true as const, batch, actor, door };
}

/** A deadlock or the ten-second lock wait: «press again», never a white page. */
function refused(err: unknown): { ok: false; error: CountActionError } & CountErrorDetail {
  if (err instanceof CountError) return { ok: false, error: err.code, ...err.detail };
  if (isBusyError(err)) return { ok: false, error: 'busy_retry' };
  throw err;
}

export async function countLoadLotAction(input: unknown): Promise<CountLoadActionResult> {
  const parsed = countLoadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'bad_target' };
  const opened = await doorFor(parsed.data.batchId);
  if (!opened.ok) return { ok: false, error: opened.error };
  const meta = await requestMeta();
  try {
    const res = await countLoadLot(parsed.data, { actorId: opened.actor.id, ...meta }, opened.door);
    // The one ⚠ alarm the press wrote goes out now rather than on the
    // minute's sweep — and a queue hiccup must not read as a failed press
    // that has already happened.
    if (res.over + res.grown > 0) {
      await enqueue(JOB_PROCESS_EVENTS, {}).catch((error: unknown) =>
        console.error('[count-load] events kick failed', error),
      );
    }
    revalidatePath(`/batches/${opened.batch.id}`);
    return { ok: true, ...res };
  } catch (err) {
    return refused(err);
  }
}

export async function countLoadCrateAction(input: unknown): Promise<CountCrateActionResult> {
  const parsed = countCrateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'bad_target' };
  const opened = await doorFor(parsed.data.batchId);
  if (!opened.ok) return { ok: false, error: opened.error };
  const meta = await requestMeta();
  try {
    const res = await countLoadCrate(parsed.data, { actorId: opened.actor.id, ...meta }, opened.door);
    revalidatePath(`/batches/${opened.batch.id}`);
    return { ok: true, ...res };
  } catch (err) {
    return refused(err);
  }
}
