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
 *   screen at a shared yard — so it stays where it departed (stated). Nor
 *   when it was ALREADY standing where the truck unloads: the unload screen
 *   «reality-wins» any known carton it is shown, so a local prixod on the
 *   Tashkent floor, or a box at the hub waiting for its onward truck,
 *   scanned by mistake, lands with a movement from the destination to the
 *   destination — it never moved, and it took a share of a China truck's
 *   road. The arrival rule's own clause (`landedHereSql`, #816): a journey is
 *   `from IS DISTINCT FROM to`. Deliberately not the stricter «from the
 *   truck's origin»: a carton whose record said it stood elsewhere (a
 *   warehouse it never reached, or written off, so no warehouse at all) and
 *   that the unloader physically took off this truck did ride it — the
 *   record was wrong, not the scan.
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

/** The same list as an SQL tuple, for readers that probe the find themselves (0104). */
export const FOUND_BACK_SQL = FOUND_BACK;

/**
 * The movements that can put a box on a truck for money (the index's causes)
 * — exported so a reader that must tell a RIDE from a mere touch of a truck
 * (the unpriced-cargo rule, 0104) asks this list and never a copy of it.
 */
export const RIDE_CAUSES = sql`('batch_departed', 'undocumented_transfer')`;

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
      OR (
        ${m}.cause = 'undocumented_transfer'
        AND ${m}.from_status IS DISTINCT FROM 'in_transit'
        AND ${m}.from_warehouse_id IS DISTINCT FROM ${m}.to_warehouse_id
      )
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

/**
 * EXISTS: a non-void box of that client is a rider of that truck, for money —
 * the live pointer before departure, the rides after it (0104). The ONE home
 * for «is this client aboard», asked by the price door (`cargoAboard`), the
 * off-truck warnings and «Partiya foydasi»'s no-cargo part, so a price the
 * door refuses is the same price the screens call «yuki ketmagan».
 */
export function clientAboardSql(batchExpr: SQL, clientExpr: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM (${riderRowsSql({ batches: batchExpr })}) car
      JOIN boxes cab ON cab.id = car.box_id
      JOIN receipt_lots cal ON cal.id = cab.lot_id
      JOIN receipts crr ON crr.id = cal.receipt_id
     WHERE crr.client_id = ${clientExpr}
  )`;
}

/** A WHERE over `boxes`: this box rode that truck (for money). */
export function riderFilter(batchId: string): SQL {
  return sql`${boxes.id} IN (
    SELECT rr.box_id FROM (${riderRowsSql({ batches: sql`${batchId}::uuid` })}) rr
  )`;
}

/**
 * A WHERE over `boxes`: this box is in the truck's DECLARATION — what a
 * customs bill is split over (the owner's rule, `truckBaseSql`): every rider,
 * and every carton scanned aboard and found back at the origin, which was
 * declared and paid for. «Rider or left behind» is exactly «rider, or
 * departed on it at all» — a departed box that is not a rider IS the
 * left-behind one — so it is written as the riders' own UNION plus the
 * truck's departures, one more `box_movements_ref_idx` lookup. As
 * `riderFilter OR leftBehindSql` it was an OR over the whole boxes table with
 * correlated subplans: a sequential scan whose cost estimate grew with every
 * box ever received and crossed the JIT thresholds, measured 1.1-1.3 s per
 * customs bill on a 60k-box year (#152's rule, which this file states).
 */
export function declaredFilter(batchId: string): SQL {
  return sql`${boxes.id} IN (
    SELECT rr.box_id FROM (${riderRowsSql({ batches: sql`${batchId}::uuid` })}) rr
    UNION
    SELECT dm.box_id FROM box_movements dm
     WHERE dm.ref_type = 'batch' AND dm.ref_id = ${batchId}::uuid
       AND dm.cause = 'batch_departed' AND ${NOT_VOID_SQL('dm')}
  )`;
}

/**
 * A cost entry (a reference to its row, `${costEntries}`) stamped with a
 * truck, converted, that holds NO share on a carton which rode that truck
 * without a load scan — a truck bill, or a grid cell of that carton's own
 * prixod. That is a re-split that never happened (U25): the carton joined
 * the riders when it was scanned off, and the truck's money was still split
 * over the scanned cargo alone. No other stale split is this invisible — a
 * found-back carton's leftover share has the dashboard's «phantom». A
 * carton that legitimately takes nothing (a direct_to_client fee for another
 * client) keeps matching, and costs the nightly sweep one idempotent re-split.
 */
export function riderWithoutShareSql(entry: SQL): SQL {
  return sql`(${entry}.amount_usd IS NOT NULL AND ${entry}.batch_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM box_movements um
     WHERE um.ref_type = 'batch' AND um.ref_id = ${entry}.batch_id AND um.cause = 'undocumented_transfer'
       AND ${NOT_VOID_SQL('um')} AND ${rideMovementSql('um')}
       AND (${entry}.scope = 'batch' OR EXISTS (
         SELECT 1 FROM boxes ub JOIN receipt_lots ul ON ul.id = ub.lot_id
          WHERE ub.id = um.box_id AND ul.receipt_id = ${entry}.receipt_id
       ))
       AND NOT EXISTS (
         SELECT 1 FROM cost_allocations ua WHERE ua.cost_entry_id = ${entry}.id AND ua.box_id = um.box_id
       )
  ))`;
}

/**
 * The box (by its alias) rode ANOTHER truck after it rode this one — so a
 * loss written against it later is that later leg's, not this truck's (U35):
 * a carton this truck delivered to the hub and the next truck lost is not
 * «not arrived» here. A departure found back at its own origin is no ride
 * (`rideMovementSql`), so a write-off at the hub after a scan onto the next
 * truck that never left still belongs to the truck that brought it.
 */
export function rodeLaterSql(batchExpr: SQL, boxAlias: string): SQL {
  const b = sql.raw(boxAlias);
  return sql`EXISTS (
    SELECT 1 FROM box_movements mine
      JOIN box_movements later ON later.box_id = mine.box_id
                              AND (later.created_at, later.id) > (mine.created_at, mine.id)
     WHERE mine.box_id = ${b}.id AND mine.ref_type = 'batch' AND mine.ref_id = ${batchExpr}
       AND mine.cause IN ${RIDE_CAUSES}
       AND later.ref_type = 'batch' AND later.ref_id <> ${batchExpr}
       AND later.cause IN ${RIDE_CAUSES} AND ${rideMovementSql('later')}
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
  /**
   * The clients whose cargo rode (0104) — from the SAME pass, so «Partiya
   * foydasi»'s no-cargo part asks no second rider probe (the regression
   * lens's performance objection). Unclaimed cargo names no client.
   */
  clientIds: string[];
}

/**
 * What rode each truck: boxes, and kg / m³ as each box's share of its lot —
 * the base a per-kg figure divides by, so it must be the base the freight was
 * split over — and whose it was. One grouped query for a whole report (#432).
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
           coalesce(sum(rl.total_volume_m3 / rl.box_count), 0) AS m3,
           coalesce(array_agg(DISTINCT rr.client_id::text) FILTER (WHERE rr.client_id IS NOT NULL), '{}') AS client_ids
      FROM riders r
      JOIN boxes bx ON bx.id = r.box_id
      JOIN receipt_lots rl ON rl.id = bx.lot_id
      JOIN receipts rr ON rr.id = rl.receipt_id
     GROUP BY r.batch_id
  `)) as unknown as { batch_id: string; boxes: number; kg: string; m3: string; client_ids: string[] }[];
  for (const row of rows) {
    out.set(row.batch_id, {
      boxCount: Number(row.boxes),
      kg: Number(row.kg),
      m3: Number(row.m3),
      clientIds: row.client_ids ?? [],
    });
  }
  return out;
}
