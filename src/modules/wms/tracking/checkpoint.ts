import { eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../../platform/audit/service';
import { db } from '../../platform/db/client';
import { batches, warehouses } from '../../platform/db/schema';
import { AuthError, type Actor } from '../../platform/rbac/authorize';
import { assertOnBatchCard } from '../batches/batch-authorize';
import { checkpointsFor } from './eta';
import { CHECKPOINT_KEYS, type CheckpointKey } from './map-data';

/**
 * The logist's «where is the truck» pin, written (the Mashina tab's buttons).
 *
 * It used to be written by the action itself, which checked the key against
 * a hand-typed list of three and wrote any of them onto any truck. With the
 * Horgos road that list stopped being one list: a Kashgar truck passes
 * Kyrgyzstan and a Horgos truck Kazakhstan, and a pin naming a leg the truck
 * does not drive anchors nothing — the engine ignores it and the dashboard
 * dropped it, so the press looked accepted and changed no date anywhere.
 * The screen offers only the truck's own keys (`checkpointsFor`); this is the
 * half that makes a hand-made post obey the same list (#531).
 *
 * Clearing the pin the truck carries is ALWAYS allowed, on-route or not: a
 * pin written before this rule existed must stay removable, or it is stuck on
 * the truck for ever.
 */

export type CheckpointErrorCode = 'forbidden' | 'not_in_transit' | 'unknown_key' | 'not_on_route';

export class CheckpointError extends Error {
  constructor(public readonly code: CheckpointErrorCode) {
    super(code);
  }
}

/** What the buttons' form state carries back: a refusal in words, or done. */
export type CheckpointActionState = { ok: true } | { error: CheckpointErrorCode } | null;

type Pinner = Pick<Actor, 'id' | 'permissions' | 'warehouseScoped' | 'warehouseIds'>;

/**
 * Press a pin: set it, or clear it when it is the one the truck carries.
 * One transaction, `tx` only (#714): the truck under `FOR UPDATE` — two
 * logists pressing at once must not each read the other's pin as absent —
 * then its two ends, the card's door, the status, the road, the write and the
 * audit. The permission is asked here as well as in the action, because the
 * action's door is the session's and this is the one a test can press.
 */
export async function setTrackingCheckpoint(
  actor: Pinner,
  batchId: string,
  key: string,
  meta: { ip: string | null; userAgent: string | null },
): Promise<{ key: CheckpointKey; at: string } | null> {
  if (!actor.permissions.has('batches.vehicle_info')) throw new CheckpointError('forbidden');
  if (!(CHECKPOINT_KEYS as readonly string[]).includes(key)) throw new CheckpointError('unknown_key');
  const pressed = key as CheckpointKey;

  return db.transaction(async (tx) => {
    const [batch] = await tx.select().from(batches).where(eq(batches.id, batchId)).for('update');
    // A truck that is not there is not on the road either — said in words
    // rather than as a door the presser cannot tell from a refusal.
    if (!batch) throw new CheckpointError('not_in_transit');
    try {
      assertOnBatchCard(actor, batch);
    } catch (err) {
      if (err instanceof AuthError) throw new CheckpointError('forbidden');
      throw err;
    }
    if (batch.status !== 'in_transit') throw new CheckpointError('not_in_transit');

    const current = (batch.trackingCheckpoint as { key?: unknown } | null)?.key;
    let next: { key: CheckpointKey; at: string } | null;
    if (current === pressed) {
      next = null;
    } else {
      const ends = await tx
        .select({ id: warehouses.id, code: warehouses.code, country: warehouses.country })
        .from(warehouses)
        .where(inArray(warehouses.id, [batch.originWarehouseId, batch.destWarehouseId]));
      const origin = ends.find((w) => w.id === batch.originWarehouseId);
      const dest = ends.find((w) => w.id === batch.destWarehouseId);
      const offered = checkpointsFor(origin?.code ?? '', dest?.code ?? '', dest?.country ?? null);
      if (!offered.includes(pressed)) throw new CheckpointError('not_on_route');
      next = { key: pressed, at: new Date().toISOString() };
    }

    await tx.update(batches).set({ trackingCheckpoint: next }).where(eq(batches.id, batchId));
    await writeAudit(tx, { actorId: actor.id, ...meta, warehouseId: batch.originWarehouseId }, {
      entityType: 'batch',
      entityId: batchId,
      action: 'update',
      after: { trackingCheckpoint: next },
    });
    return next;
  });
}
