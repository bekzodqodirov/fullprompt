import { and, ne, sql, type SQL } from 'drizzle-orm';
import { batches } from '../../platform/db/schema';
import { mayAt, warehouseScope, type ScopedActor } from '../../platform/rbac/scope';

/**
 * Who may ADD a bill to this truck (docs/SARFLAR.md §8.5) — ONE predicate,
 * asked by the cost action's batch branch, the per-prixod grid's action, the
 * truck tab's «＋» and the general entry page's picker and `?p=` alike, so a
 * drawn «＋» never meets a refusal and a refusal never sits behind a hidden
 * button (#531, #1023).
 *
 * Two halves and no third:
 *  - not on a cancelled truck — a cancelled truck is a trip that never
 *    happened, and its cancellation refused live costs (`cancelBatch`'s money
 *    guard); a bill typed onto it afterwards is money landing on cargo that
 *    went back to the shelf. The SERVICE refuses it too, under the truck's
 *    lock (`addCostEntry`), because a picker is not a fence;
 *  - `costs.enter_batch` at the truck's ORIGIN, today's rule (costs/actions.ts),
 *    stated rather than widened: no seeded warehouse-scoped role holds it.
 *
 * It is the ADD door only. The void door stays `costs.enter_batch` at origin
 * and status-blind: the annul deliberately leaves kassa-paid truck costs live
 * on a truck it retires, for a person to void (annul.ts) — so a cancelled
 * truck keeps its 🗑 and loses its «＋».
 */
export interface CostDoorBatch {
  status: string;
  originWarehouseId: string;
}

export function mayEnterBatchCost(
  actor: ScopedActor & { permissions: ReadonlySet<string> },
  batch: CostDoorBatch,
): boolean {
  return batch.status !== 'cancelled' && mayAt(actor, 'costs.enter_batch', batch.originWarehouseId);
}

/**
 * The same predicate as SQL over the UNALIASED `batches` table, for a list
 * whose rows AND count must agree («N tadan 20»): filtering fetched rows with
 * the JS form would print a count of trucks the list then hides. Pinned
 * against `mayEnterBatchCost` by a role × status × scope matrix.
 */
export function mayEnterBatchCostWhere(actor: ScopedActor & { permissions: ReadonlySet<string> }): SQL {
  if (!actor.permissions.has('costs.enter_batch')) return sql`false`;
  return and(ne(batches.status, 'cancelled'), warehouseScope(actor, batches.originWarehouseId))!;
}
