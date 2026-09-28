import { eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches } from '../../platform/db/schema';
import { isUuidShaped } from '../../platform/audit/fields';
import { AuthError, authorize, type Actor } from '../../platform/rbac/authorize';
import type { PermissionCode } from '../../platform/rbac/catalog';
import type { ScopedActor } from '../../platform/rbac/scope';
import { mayOpenBatchCard, type BatchEnds } from './card-door';

export type BatchRow = typeof batches.$inferSelect;

/**
 * The door for an action that changes ONE truck: the permission, then the
 * truck card's own door (docs/CARD-TABS.md, «Holes found on the way»).
 *
 * `authorize(code, {})` judges the warehouse only when it is handed one, and
 * eight actions on the truck card handed it none — the VED's papers, the
 * customs firm and the per-prixod customs, «rastamojka tugadi», the «Partiya»
 * mark, the map pin, and pairing and revoking the driver's phone. Three of
 * those are `batches.vehicle_info`, which the seed gives to the warehouse-
 * SCOPED roles, so a Yiwu operator could move the pin of a truck that never
 * touched Yiwu — which is that customer's stage and arrival date in the
 * cabinet — and pair or revoke its driver's phone. A permission says WHAT a
 * person may do; only a warehouse says to WHICH truck.
 *
 * The scope half is `mayOpenBatchCard` and never a restatement of it (#513):
 * whoever may open the truck's card may press what the card offers them,
 * judged by the truck's TWO ends. The permission is authorize's own question,
 * asked FIRST, so a door nobody holds the key to never says whether a truck
 * exists.
 *
 * `null` is a truck that is not there, which the actions answer by returning
 * quietly, as they always did — a garbage id included, which would otherwise
 * reach postgres as a 22P02 and a white page (#472). A refusal is authorize's
 * own `AuthError('forbidden')`, so everything that already handles authorize
 * handles this. The row comes back with the actor, so no action reads the
 * truck a second time.
 */
export async function authorizeOnBatch(
  permission: PermissionCode,
  batchId: string,
): Promise<{ actor: Actor; batch: BatchRow } | null> {
  const actor = await authorize(permission);
  if (!isUuidShaped(batchId)) return null;
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return null;
  assertOnBatchCard(actor, batch);
  return { actor, batch };
}

/**
 * The scope half on its own, pure: the card's door, refused in authorize's own
 * words. Exported so the decision can be proved over the seeded roles without
 * a request (tests/unit/batch-authorize.test.ts).
 */
export function assertOnBatchCard(actor: ScopedActor, batch: BatchEnds): void {
  if (!mayOpenBatchCard(actor, batch)) {
    throw new AuthError('Batch out of scope', 'forbidden');
  }
}
