import { eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../../platform/audit/service';
import { db } from '../../platform/db/client';
import { batches, warehouses } from '../../platform/db/schema';
import { AuthError, type Actor } from '../../platform/rbac/authorize';
import { assertOnBatchCard } from '../batches/batch-authorize';
import { checkpointsFor, placedBehindPin, roadHolds } from './eta';
import { CHECKPOINT_KEYS, type CheckpointKey } from './map-data';
import { trucksOnRoadRows } from './on-road';

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
 * Clearing the pin the truck carries is allowed, on-route or not: a pin
 * written before this rule existed must stay removable, or it is stuck on the
 * truck for ever — EXCEPT a pin of a road that HOLDS (docs/XORGOS-NAVBAT.md,
 * Horgos): there the pin is what moved the truck past a queue, and clearing
 * «Qozog‘istonda» by tapping it again to «confirm» sent a truck in Kazakhstan
 * back into the Horgos queue, late, with a warning to every logist (the
 * design's judge). On that road a press of the standing pin:
 * - «Horgosda turibdi» RE-STAMPS it: again after the call, the queue counts
 *   from the press (and a wait counted from after the warning re-arms it);
 * - «Qozog‘istonda» / «O‘zbekistonda» re-stamps only when the truck reads
 *   BEHIND that pin's leg — a newer phone fix overruled it, and the warning
 *   names this very button (the review: refusing it left the logist told to
 *   press a button that refused). Otherwise it changes nothing: a «confirm»
 *   tap of «Qozog‘istonda» for a truck at Yallama must not restart the
 *   Kazakh leg and with it the Yallama count (the fixes' review).
 * An off-route pin on that road still clears.
 */

export type CheckpointErrorCode =
  | 'forbidden'
  | 'not_in_transit'
  | 'unknown_key'
  | 'not_on_route'
  | 'checkpoint_changed';

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
 *
 * `seenKey` is the pin the presser's screen showed ('' = none). A press is a
 * toggle, so on a page a colleague has pinned since, «Chegarada» meant as
 * «set» would CLEAR the pin that colleague just set — and the batch board
 * keeps a page open for a long while. Compared under the lock, it refuses
 * `checkpoint_changed` instead (the rename's `seenCode`, #1252). Absent =
 * a caller that does not know (an old page), which keeps the old toggle.
 */
export async function setTrackingCheckpoint(
  actor: Pinner,
  batchId: string,
  key: string,
  meta: { ip: string | null; userAgent: string | null },
  seenKey?: string,
): Promise<{ key: CheckpointKey; at: string } | null> {
  if (!actor.permissions.has('batches.vehicle_info')) throw new CheckpointError('forbidden');
  if (!(CHECKPOINT_KEYS as readonly string[]).includes(key)) throw new CheckpointError('unknown_key');
  const pressed = key as CheckpointKey;

  // Where the truck reads NOW, for a re-press of «Qozog‘istonda» /
  // «O‘zbekistonda» on a road that holds — on the POOL, before the
  // transaction opens (#714); the pin it was read under is compared under the
  // lock below.
  let readUnder: { key: unknown; behind: boolean } | null = null;
  if (pressed === 'in_kz' || pressed === 'in_uz') {
    const [pre] = await db
      .select({ cp: batches.trackingCheckpoint })
      .from(batches)
      .where(eq(batches.id, batchId));
    const preKey = (pre?.cp as { key?: unknown } | null)?.key;
    if (preKey === pressed) {
      const row = (await trucksOnRoadRows([batchId])).get(batchId);
      readUnder = {
        key: preKey,
        behind: row ? placedBehindPin(row.originCode, row.destCode, row.segKey, pressed) : false,
      };
    }
  }

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
    // A stored key the buttons never write is no pin to a screen either
    // (the Mashina tab draws it as none), so it reads as '' here.
    const shown =
      typeof current === 'string' && (CHECKPOINT_KEYS as readonly string[]).includes(current) ? current : '';
    if (seenKey !== undefined && shown !== seenKey) throw new CheckpointError('checkpoint_changed');
    const ends = await tx
      .select({ id: warehouses.id, code: warehouses.code, country: warehouses.country })
      .from(warehouses)
      .where(inArray(warehouses.id, [batch.originWarehouseId, batch.destWarehouseId]));
    const origin = ends.find((w) => w.id === batch.originWarehouseId);
    const dest = ends.find((w) => w.id === batch.destWarehouseId);
    const offered = checkpointsFor(origin?.code ?? '', dest?.code ?? '', dest?.country ?? null);
    let next: { key: CheckpointKey; at: string } | null;
    if (current === pressed) {
      if (offered.includes(pressed) && roadHolds(origin?.code ?? '', dest?.code ?? '')) {
        if (pressed !== 'at_border') {
          // Read under another pin than the one now locked: say so rather
          // than decide on a stale placement.
          if (!readUnder || readUnder.key !== current) throw new CheckpointError('checkpoint_changed');
          // The screen already shows it there: nothing to write, nothing to audit.
          if (!readUnder.behind) return batch.trackingCheckpoint as { key: CheckpointKey; at: string };
        }
        next = { key: pressed, at: new Date().toISOString() };
      } else next = null;
    } else {
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
