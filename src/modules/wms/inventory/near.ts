import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, boxes } from '../../platform/db/schema';

/**
 * Is the cargo where this person is standing?
 *
 * A receipt's `warehouse_id` is where the goods were RECEIVED, and it never
 * moves — so a Kashgar prixod whose cartons are now in Andijan belongs, by
 * that column, to a warehouse the Andijan operator has nothing to do with.
 * Measured on the owner's data in round 90: of 4,403 goods photographs, 1,362
 * (31 %) could not be opened by the operator standing next to the box.
 *
 * The rule is the one `wms/search` and the bot's lookup already use for a box,
 * and NOT a new one: the warehouse the carton is standing in, or — while it is
 * in transit and standing in none — the TWO ends of the truck it is riding.
 * Filtered in SQL rather than over a fetched page, because a receipt can carry
 * hundreds of boxes and a `limit` would answer «not yours» about the one box
 * that is.
 *
 * It lived inside `wms/attachments/access.ts` until the handover list needed
 * it too (owner's item 3): an unclaimed row links to the prixod, and the whole
 * point of the row is that the person reading it is standing over the cargo.
 * A second statement of the rule is how the photograph and the page it sits on
 * would come to disagree about the same carton (#513).
 */
export async function cargoNearActor(
  actor: { warehouseIds: string[] },
  lotFilter: SQL,
): Promise<boolean> {
  const ids = actor.warehouseIds;
  if (ids.length === 0) return false;
  const [row] = await db
    .select({ boxId: boxes.id })
    .from(boxes)
    .leftJoin(batches, eq(boxes.currentBatchId, batches.id))
    .where(
      and(
        lotFilter,
        or(
          inArray(boxes.currentWarehouseId, ids),
          inArray(batches.originWarehouseId, ids),
          inArray(batches.destWarehouseId, ids),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}
