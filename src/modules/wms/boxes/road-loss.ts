import { sql, type SQL } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { inScope, type ScopedActor } from '../../platform/rbac/scope';

/**
 * The truck a carton was lost ON THE ROAD from (U38): the newest
 * `lost_in_transit` movement's truck, while the box is still lost in NO
 * warehouse — NULL for every other box.
 *
 * `resolveMissing` clears both pointers of a road-lost carton (it stands in
 * no warehouse and rides no truck), so every reader that judged a box by its
 * own warehouse or its live truck lost sight of it: the box card answered 404
 * and the search found nothing for the destination manager — the one person
 * who pressed «Yo'lda yo'qoldi», and the one who has to bring the carton back
 * when it turns up. The movement ledger still names the truck, and its two
 * ends are the warehouses with a reason to see it (/transit's rule, and the
 * cargo-risk report's). ONE statement of it (#513): the SQL readers embed
 * this fragment, the ones holding a single box ask `roadLossTruck`.
 *
 * Gated on the box's CURRENT state, not on the movement alone: a carton lost
 * on the road, found, and later written off on a shelf has a warehouse again
 * and answers to it. The movements are ordered by `(created_at, id)` — two
 * writes of one transaction share a timestamp.
 */
export function roadLossBatchSql(boxAlias: string): SQL {
  const b = sql.raw(boxAlias);
  return sql`(CASE WHEN ${b}.status = 'lost' AND ${b}.current_warehouse_id IS NULL THEN (
    SELECT lm.ref_id FROM box_movements lm
     WHERE lm.box_id = ${b}.id AND lm.cause = 'lost_in_transit' AND lm.ref_type = 'batch'
     ORDER BY lm.created_at DESC, lm.id DESC
     LIMIT 1
  ) END)`;
}

export interface RoadLossTruck {
  id: string;
  originWarehouseId: string;
  destWarehouseId: string;
}

/** `roadLossBatchSql` for one box, with the truck's two ends — on the caller's handle. */
export async function roadLossTruck(
  boxId: string,
  handle: Db | Tx = db,
): Promise<RoadLossTruck | null> {
  const rows = await handle.execute<{ id: string; origin: string; dest: string }>(sql`
    SELECT bt.id, bt.origin_warehouse_id AS origin, bt.dest_warehouse_id AS dest
      FROM boxes b
      JOIN batches bt ON bt.id = ${roadLossBatchSql('b')}
     WHERE b.id = ${boxId}
  `);
  const row = rows[0];
  return row ? { id: row.id, originWarehouseId: row.origin, destWarehouseId: row.dest } : null;
}

/** A scoped reader reaches a road-lost carton from either end of the truck it was lost from. */
export function roadLossInScope(
  actor: ScopedActor,
  truck: Pick<RoadLossTruck, 'originWarehouseId' | 'destWarehouseId'> | null,
): boolean {
  return (
    truck !== null &&
    (inScope(actor, truck.originWarehouseId) || inScope(actor, truck.destWarehouseId))
  );
}

/**
 * The box card's door: where the carton stands, or the warehouse that
 * received it (a box in transit has left its origin, and that warehouse must
 * not lose sight of it the moment the truck pulls away) — and, lost on the
 * road, either end of the truck it was lost from, or the destination manager
 * who recorded the loss could never reach the one door that brings it back.
 * The truck is read only for that last case.
 */
export async function mayOpenBoxCard(
  actor: ScopedActor,
  box: { id: string; status: string; currentWarehouseId: string | null },
  receiptWarehouseId: string,
): Promise<boolean> {
  if (inScope(actor, box.currentWarehouseId) || inScope(actor, receiptWarehouseId)) return true;
  if (box.status !== 'lost' || box.currentWarehouseId) return false;
  return roadLossInScope(actor, await roadLossTruck(box.id));
}
