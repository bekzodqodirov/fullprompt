import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { boxes } from '../../platform/db/schema';

/**
 * Who REALLY rode a truck, for MONEY — one rule for every reader that splits,
 * sums or prints a truck's cost (audit U17 + U25; DECISIONS #15 decided it
 * and neither half was built).
 *
 * `batchMemberFilter` answers «what was on this truck's manifest» and is
 * right for the documents, the unload counter and the arrival notices — a
 * paper that left the company must not change its claims (#121, #643). It is
 * wrong for money in two directions, and both are ordinary floor events:
 *
 * - A carton scanned as loaded that never left the origin (the owner's own
 *   «yukladim deb skan qildim … tushirib qoldirdi», 2026-08-25). Its
 *   `batch_departed` row is permanent, so it went on taking the truck's
 *   freight: the cargo that did ride was under-costed by its share, and when
 *   the carton rode the NEXT truck that share came along as «shu reysgacha».
 *   It is not a rider once it is FOUND BACK at the truck's origin —
 *   `found_at_origin` (the manager's resolution) or `inventory_found` (the
 *   loader's accept-found and the stocktake, ref 'manual', so no backfill is
 *   needed) — with no other departure of the box in between. A find at the
 *   destination or at a third warehouse proves nothing about the road and
 *   keeps the box aboard; so does `found_here`.
 * - A carton that rode WITHOUT a load scan (a planned box the scanner missed,
 *   short-loaded back to the shelf, and on the truck anyway). It lands with
 *   `undocumented_transfer` and never gets a `batch_departed`, so it paid
 *   none of the truck's costs and the scanned cargo paid its share (#71,
 *   #337 already treat it as having arrived on that truck). It is the
 *   truck's cargo unless it came off ANOTHER truck's manifest
 *   (`from_status = 'in_transit'`): that box already carries its own
 *   departure, and the scan may simply have been made on the wrong truck's
 *   screen at a shared yard — so it stays where it departed (stated).
 *
 * Before departure the live pointer is membership, as it always was. A void
 * box is never cargo (the annul round).
 *
 * The movements are ordered by `(created_at, id)`: two writes of one
 * transaction share a timestamp, the identity breaks the tie.
 */

/** The causes that land a carton back where a truck started — it never left. */
export const FOUND_BACK_CAUSES = ['found_at_origin', 'inventory_found'] as const;

const FOUND_BACK = sql.raw(`(${FOUND_BACK_CAUSES.map((cause) => `'${cause}'`).join(', ')})`);

/** The movements that can put a box on a truck for money (the index's causes). */
const RIDE_CAUSES = sql`('batch_departed', 'undocumented_transfer')`;

/**
 * A movement (by alias) of a box that is not void — as an anti-join probe by
 * primary key, not a join to `boxes`: joined, the planner hashed the whole
 * boxes table to filter a few thousand rows.
 */
const NOT_VOID_SQL = (alias: string) =>
  sql`NOT EXISTS (SELECT 1 FROM boxes vb WHERE vb.id = ${sql.raw(alias)}.box_id AND vb.status = 'void')`;

/**
 * A movement row (by its alias) that makes its box a rider of `ref_id`: the
 * departure or the unscanned landing, and never found back at that truck's
 * origin before the box departed again.
 */
export function rideMovementSql(alias: string): SQL {
  const m = sql.raw(alias);
  return sql`(
    ${m}.ref_type = 'batch'
    AND (
      ${m}.cause = 'batch_departed'
      OR (${m}.cause = 'undocumented_transfer' AND ${m}.from_status IS DISTINCT FROM 'in_transit')
    )
    AND NOT EXISTS (
      SELECT 1 FROM box_movements back
        JOIN batches ob ON ob.id = ${m}.ref_id
       WHERE back.box_id = ${m}.box_id
         AND (back.created_at, back.id) > (${m}.created_at, ${m}.id)
         AND back.to_warehouse_id = ob.origin_warehouse_id
         AND back.cause IN ${FOUND_BACK}
         AND NOT EXISTS (
           SELECT 1 FROM box_movements again
            WHERE again.box_id = ${m}.box_id
              AND again.cause = 'batch_departed'
              AND (again.created_at, again.id) > (${m}.created_at, ${m}.id)
              AND (again.created_at, again.id) < (back.created_at, back.id)
         )
    )
  )`;
}

/**
 * `(batch_id, box_id)` — every box that rode each truck, for money. Either
 * for a list of trucks (`batches`: a comma list or a correlated reference) or
 * for every truck a set of boxes rode (`boxes`: a subquery of box ids).
 * Written as the UNION of the two indexed lookups, never an OR in a join
 * predicate (#152): the pointer by `boxes_current_batch_idx`, the movements
 * by `box_movements_ref_idx` / `box_movements_box_idx`.
 */
export function riderRowsSql(of: { batches: SQL } | { boxes: SQL }): SQL {
  if ('batches' in of) {
    return sql`
      SELECT b.current_batch_id AS batch_id, b.id AS box_id FROM boxes b
       WHERE b.current_batch_id IN (${of.batches}) AND b.status <> 'void'
      UNION
      SELECT rm.ref_id AS batch_id, rm.box_id FROM box_movements rm
       WHERE rm.ref_type = 'batch' AND rm.ref_id IN (${of.batches})
         AND rm.cause IN ${RIDE_CAUSES} AND ${NOT_VOID_SQL('rm')}
         AND ${rideMovementSql('rm')}`;
  }
  return sql`
    SELECT b.current_batch_id AS batch_id, b.id AS box_id FROM boxes b
     WHERE b.id IN (${of.boxes}) AND b.current_batch_id IS NOT NULL AND b.status <> 'void'
    UNION
    SELECT rm.ref_id AS batch_id, rm.box_id FROM box_movements rm
     WHERE rm.box_id IN (${of.boxes}) AND rm.ref_type = 'batch'
       AND rm.cause IN ${RIDE_CAUSES} AND ${NOT_VOID_SQL('rm')}
       AND ${rideMovementSql('rm')}`;
}

/**
 * The riders of a LIST of trucks and every ride of those same boxes, as CTEs
 * for a query to continue from: `box_rides(batch_id, box_id)` — each ride of
 * each box that touched the trucks — and `members(batch_id, box_id)` — the
 * rides on the listed trucks themselves. One pass of the found-back probe
 * serves both (measured: the landed-cost read of a month's 60 trucks over a
 * 60k-box year ran the probe twice otherwise).
 */
export function riderCtesSql(list: SQL): SQL {
  return sql`
    rider_cand AS (
      SELECT b.id AS box_id FROM boxes b WHERE b.current_batch_id IN (${list})
      UNION
      SELECT rm.box_id FROM box_movements rm
       WHERE rm.ref_type = 'batch' AND rm.ref_id IN (${list}) AND rm.cause IN ${RIDE_CAUSES}
    ),
    box_rides AS (${riderRowsSql({ boxes: sql`SELECT box_id FROM rider_cand` })}),
    members AS (SELECT batch_id, box_id FROM box_rides WHERE batch_id IN (${list}))`;
}

/** A WHERE over `boxes`: this box rode that truck (for money). */
export function riderFilter(batchId: string): SQL {
  return sql`${boxes.id} IN (
    SELECT rr.box_id FROM (${riderRowsSql({ batches: sql`${batchId}::uuid` })}) rr
  )`;
}

/**
 * A box (by its alias) that DEPARTED on the truck and yet is not its rider —
 * scanned as loaded and found back at the origin. The pricing screen names
 * how many of a lot's cartons stayed behind (U35), and the dashboard's
 * «phantom» counts those still carrying the truck's freight (money a
 * recompute has not yet moved off them).
 */
export function leftBehindSql(batchExpr: SQL, boxAlias: string): SQL {
  const b = sql.raw(boxAlias);
  return sql`(
    ${b}.status <> 'void'
    AND ${b}.current_batch_id IS DISTINCT FROM ${batchExpr}
    AND EXISTS (
      SELECT 1 FROM box_movements dm
       WHERE dm.box_id = ${b}.id AND dm.ref_type = 'batch' AND dm.ref_id = ${batchExpr}
         AND dm.cause = 'batch_departed'
    )
    AND NOT EXISTS (
      SELECT 1 FROM box_movements rm
       WHERE rm.box_id = ${b}.id AND rm.ref_type = 'batch' AND rm.ref_id = ${batchExpr}
         AND rm.cause IN ${RIDE_CAUSES} AND ${rideMovementSql('rm')}
    )
  )`;
}

export interface RiderLoad {
  boxCount: number;
  kg: number;
  m3: number;
}

/**
 * What rode each truck: boxes, and kg / m³ as each box's share of its lot —
 * the base a per-kg figure divides by, so it must be the base the freight was
 * split over. One grouped query for a whole report (#432).
 */
export async function riderLoad(batchIds: string[]): Promise<Map<string, RiderLoad>> {
  const ids = [...new Set(batchIds)];
  const out = new Map<string, RiderLoad>();
  if (ids.length === 0) return out;
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    WITH riders AS (${riderRowsSql({ batches: list })})
    SELECT r.batch_id, count(*)::int AS boxes,
           coalesce(sum(rl.total_weight_kg / rl.box_count), 0) AS kg,
           coalesce(sum(rl.total_volume_m3 / rl.box_count), 0) AS m3
      FROM riders r
      JOIN boxes bx ON bx.id = r.box_id
      JOIN receipt_lots rl ON rl.id = bx.lot_id
     GROUP BY r.batch_id
  `)) as unknown as { batch_id: string; boxes: number; kg: string; m3: string }[];
  for (const row of rows) {
    out.set(row.batch_id, { boxCount: Number(row.boxes), kg: Number(row.kg), m3: Number(row.m3) });
  }
  return out;
}
