import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { leftBehindSql, rideMovementSql } from '../batches/riders';
import { customsCostTypeIds, recomputeAll, recomputeEntry } from './service';

/**
 * The one-off repair for allocations written before the rider rule (audit
 * U17, U25, U18). The rule is read-side and needs no migration, but an
 * allocation is a stored split: a truck's freight already sitting on a carton
 * that never boarded, a truck whose unscanned rider was given nothing, and a
 * grid cell spread over the whole prixod all stay as they are until their
 * entry is re-split. The dollars are frozen (R1), so only the per-box shares
 * move — no P&L, partner charge or kassa figure changes; past trucks'
 * tannarx and «Partiya foydasi» do (a recorded correction, #849's shape).
 *
 * The logic lives here so it can be tested; `scripts/repair-riders.ts` is
 * the thin shell: a dry run by default, `--apply` to write.
 */
export interface RiderRepairPlan {
  /**
   * Trucks carrying a carton found back at their origin, and the ROAD money
   * still sitting on it (a customs share stays by the owner's rule).
   */
  leftBehind: { batchId: string; code: string; boxes: number; usd: number }[];
  /** Trucks a carton came off without a load scan (a rider the old base skipped). */
  rogue: { batchId: string; code: string; boxes: number }[];
  /** Live grid cells (receipt scope, stamped with a truck) — each re-splits over its truck's riders. */
  stampedCells: { id: string; batchId: string }[];
}

export async function riderRepairPlan(): Promise<RiderRepairPlan> {
  const customs = await customsCostTypeIds();
  const road = customs.length
    ? sql`AND ce.cost_type_id NOT IN (${sql.join(
        customs.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql``;
  const [leftBehind, rogue, cells] = await Promise.all([
    // Starts from the found-back movements, which are few, then asks the
    // riders' own rule — the same shape as the dashboard's «phantom».
    db.execute(sql`
      WITH lb AS (
        SELECT DISTINCT dm.ref_id AS batch_id, dm.box_id
          FROM box_movements fb
          JOIN box_movements dm ON dm.box_id = fb.box_id
                               AND dm.ref_type = 'batch' AND dm.cause = 'batch_departed'
          JOIN boxes b ON b.id = dm.box_id
         WHERE fb.cause IN ('found_at_origin', 'inventory_found')
           AND ${leftBehindSql(sql`dm.ref_id`, 'b')}
      )
      SELECT bt.id AS batch_id, bt.code, count(DISTINCT lb.box_id)::int AS boxes,
             coalesce(sum(ca.amount_usd) FILTER (WHERE ce.id IS NOT NULL), 0) AS usd
        FROM lb
        JOIN batches bt ON bt.id = lb.batch_id
        LEFT JOIN cost_allocations ca ON ca.box_id = lb.box_id
        LEFT JOIN cost_entries ce ON ce.id = ca.cost_entry_id
                                 AND ce.batch_id = lb.batch_id AND ce.voided_at IS NULL ${road}
       GROUP BY bt.id, bt.code
       ORDER BY bt.code
    `) as unknown as Promise<{ batch_id: string; code: string; boxes: number; usd: string }[]>,
    db.execute(sql`
      SELECT bt.id AS batch_id, bt.code, count(DISTINCT rm.box_id)::int AS boxes
        FROM box_movements rm
        JOIN boxes b ON b.id = rm.box_id AND b.status <> 'void'
        JOIN batches bt ON bt.id = rm.ref_id
       WHERE rm.ref_type = 'batch' AND rm.cause = 'undocumented_transfer'
         AND ${rideMovementSql('rm')}
       GROUP BY bt.id, bt.code
       ORDER BY bt.code
    `) as unknown as Promise<{ batch_id: string; code: string; boxes: number }[]>,
    db.execute(sql`
      SELECT ce.id, ce.batch_id FROM cost_entries ce
       WHERE ce.voided_at IS NULL AND ce.scope = 'receipt' AND ce.batch_id IS NOT NULL
    `) as unknown as Promise<{ id: string; batch_id: string }[]>,
  ]);
  return {
    leftBehind: leftBehind.map((row) => ({
      batchId: row.batch_id,
      code: row.code,
      boxes: Number(row.boxes),
      usd: Math.round(Number(row.usd) * 100) / 100,
    })),
    rogue: rogue.map((row) => ({ batchId: row.batch_id, code: row.code, boxes: Number(row.boxes) })),
    stampedCells: cells.map((row) => ({ id: row.id, batchId: row.batch_id })),
  };
}

export interface RiderRepairFailure {
  /** The truck whose re-split failed, or the stamped cell's truck. */
  batchId: string;
  /** Set when a single stamped cell failed (not a whole truck). */
  entryId: string | null;
  message: string;
}

/**
 * Re-split what the plan names: every live entry of each listed truck (its
 * own bills and its stamped grid cells), then the stamped cells of every
 * other truck. Idempotent — a second run moves nothing.
 *
 * One truck's failure costs that truck, and one cell's that cell: a failing
 * entry used to throw out of the loop (`recomputeEach` throws once at the
 * end of a truck), so every truck after it in the plan's fixed order — and
 * every stamped cell — stayed unrepaired, and a rerun stopped at the same
 * truck again. The failures come back named, for the script to print.
 */
export async function applyRiderRepair(
  plan: RiderRepairPlan,
): Promise<{ trucks: number; entries: number; failed: RiderRepairFailure[] }> {
  const trucks = [...new Set([...plan.leftBehind, ...plan.rogue].map((row) => row.batchId))];
  const failed: RiderRepairFailure[] = [];
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
  let entries = 0;
  for (const batchId of trucks) {
    try {
      entries += await recomputeAll({ batchId });
    } catch (error) {
      failed.push({ batchId, entryId: null, message: reason(error) });
    }
  }
  // A cell of a truck already re-split above was re-split with it.
  const done = new Set(trucks);
  for (const cell of plan.stampedCells.filter((row) => !done.has(row.batchId))) {
    try {
      await recomputeEntry(cell.id);
      entries += 1;
    } catch (error) {
      failed.push({ batchId: cell.batchId, entryId: cell.id, message: reason(error) });
    }
  }
  return { trucks: trucks.length, entries, failed };
}
