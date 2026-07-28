import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, boxes, expectedArrivals } from '../../platform/db/schema';
import { hasNoWarehouse, type ScopedActor } from '../../platform/rbac/scope';

/**
 * The numbers on a warehouse worker's home screen.
 *
 * Owner: "har bir hodim qiladigan ishiga qarab layout tuz" — a skladchi's day
 * is a sequence, not a menu: what is coming → receive it → load it → hand it
 * over. The home screen draws that sequence, and each step carries the number
 * that says whether it needs them NOW. A row that reads «Yuklash · 2 partiya»
 * is an instruction; a bare tile is a door.
 *
 * Four counts, each one indexed slice of a small-or-indexed table
 * (`batches_origin_status_idx`, `boxes_wh_status_idx`; `expected_arrivals`
 * is small by nature — promises close as cargo lands). The home screen is the
 * most-opened page in the app, so nothing here may cost real time.
 *
 * Scope is the same three-answer rule as everywhere (`rbac/scope.ts`): not
 * scoped → the whole company; scoped → their warehouses; scoped with NONE →
 * zeros, never everything.
 */
export interface WarehouseFlowCounts {
  /** Trucks on the road towards my warehouse (in_transit / arrived). */
  trucksIncoming: number;
  /** Promises still open: cargo a client said would come here. */
  expectedWaiting: number;
  /** …of which the promised date has already passed. */
  expectedLate: number;
  /** Batches being formed or loaded FROM my warehouse. */
  loadingBatches: number;
  /** Boxes a client could collect right now. */
  readyBoxes: number;
}

const NOTHING: WarehouseFlowCounts = {
  trucksIncoming: 0,
  expectedWaiting: 0,
  expectedLate: 0,
  loadingBatches: 0,
  readyBoxes: 0,
};

export async function warehouseFlowCounts(
  actor: ScopedActor,
  /** `YYYY-MM-DD`; a promise dated before this counts as late. */
  today: string,
): Promise<WarehouseFlowCounts> {
  if (hasNoWarehouse(actor)) return NOTHING;
  const scope = actor.warehouseScoped ? actor.warehouseIds : null;

  const [trucks, expected, loading, ready] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)` })
      .from(batches)
      .where(
        and(
          inArray(batches.status, ['in_transit', 'arrived']),
          scope ? inArray(batches.destWarehouseId, scope) : undefined,
        ),
      ),
    db
      .select({
        n: sql<number>`count(*)`,
        late: sql<number>`count(*) filter (where ${expectedArrivals.expectedOn} < ${today})`,
      })
      .from(expectedArrivals)
      .where(
        and(
          eq(expectedArrivals.status, 'waiting'),
          scope ? inArray(expectedArrivals.warehouseId, scope) : undefined,
        ),
      ),
    db
      .select({ n: sql<number>`count(*)` })
      .from(batches)
      .where(
        and(
          inArray(batches.status, ['forming', 'loading']),
          scope ? inArray(batches.originWarehouseId, scope) : undefined,
        ),
      ),
    db
      .select({ n: sql<number>`count(*)` })
      .from(boxes)
      .where(
        and(
          eq(boxes.status, 'ready_for_pickup'),
          scope ? inArray(boxes.currentWarehouseId, scope) : undefined,
        ),
      ),
  ]);

  return {
    trucksIncoming: Number(trucks[0]!.n),
    expectedWaiting: Number(expected[0]!.n),
    expectedLate: Number(expected[0]!.late),
    loadingBatches: Number(loading[0]!.n),
    readyBoxes: Number(ready[0]!.n),
  };
}
