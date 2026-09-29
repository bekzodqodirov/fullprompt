import { sql, type SQL } from 'drizzle-orm';
import type { Db, Tx } from '../../platform/db/client';

/**
 * A carton standing FREE on a shelf — at a warehouse, on no truck — said once
 * (#513).
 *
 * Cargo stands there two ways: `in_stock` where it was received, or at a
 * warehouse that does not hand cargo over; `ready_for_pickup` where a truck
 * LANDED it at a warehouse the client collects from (`landedStatusFor`),
 * which in Uzbekistan is every warehouse there is. A truck may take either.
 *
 * The owner, 2026-09-28: «yuklarni partiya qilib andijon skladga olib keldim
 * endi men ularni ichki reys qilib toshkentga olib kelaman desam sklatda yuk
 * korinmay qolyabti». The quick truck has always loaded both. The PLAN path —
 * the editor's stock list, the submit's availability check, the approval's
 * reservation — asked for `in_stock` alone, so everything a truck had
 * unloaded at Andijan stood on the stock screen and was missing from the plan
 * editor. Both paths read this list now.
 */
export const PLANNABLE_STATUSES = ['in_stock', 'ready_for_pickup'] as const;
export type PlannableStatus = (typeof PLANNABLE_STATUSES)[number];

/**
 * The steps that take a carton off a shelf and make it this truck's: the
 * plan's reservation (the approval, and a count press re-reserving), a
 * loader's scan, and a carton landed at the destination straight off the
 * origin's stock (the office's over-count, 0112).
 */
const ONTO_TRUCK_CAUSES = ['plan_approved', 'load_scan', 'loaded_on_spot', 'undocumented_transfer'] as const;

const list = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

/**
 * Where a carton stood before THIS truck took it — the status its latest step
 * onto the truck FROM a shelf started from.
 *
 * Every door that gives cargo back asks this: «yuklash tugadi» for the
 * planned cartons nobody loaded, a cancelled truck, a carton the loader takes
 * back off, and the unload end's «found at the origin». Each of them wrote a
 * bare `in_stock`, which was true while a plan could only take `in_stock`
 * cargo and quietly wrong for the quick truck at Andijan already: a
 * `ready_for_pickup` carton came back `in_stock` at a warehouse the client
 * collects from, off every «tayyor» list, and the customer's cabinet read
 * «O'zbekistonda» instead of «Tayyor» for a carton that had never moved.
 *
 * The HISTORY decides, not the warehouse's type: cargo received straight
 * into a collection warehouse stands there `in_stock` (a Tashkent walk-in),
 * and giving it back as «ready» would promote it onto lists it was never on.
 * The step's own `from_status` is the fact — the reservation and the scan
 * both record it — and a carton with no such step on the truck (nothing the
 * code writes today) goes back `in_stock`, which is what every give-back
 * wrote before this rule. Ordered by `(created_at, id)`: two writes of one
 * transaction share a timestamp, and the shelf filter leaves at most one of
 * them standing (a press that reserves and loads writes `plan_approved` from
 * the shelf and `load_scan` from `planned`).
 */
export function shelfBeforeSql(boxAlias: string, batchId: SQL): SQL {
  const b = sql.raw(boxAlias);
  return sql`COALESCE((
    SELECT sm.from_status FROM box_movements sm
     WHERE sm.box_id = ${b}.id AND sm.ref_type = 'batch' AND sm.ref_id = ${batchId}
       AND sm.cause IN (${list(ONTO_TRUCK_CAUSES)})
       AND sm.from_status IN (${list(PLANNABLE_STATUSES)})
     ORDER BY sm.created_at DESC, sm.id DESC
     LIMIT 1
  ), 'in_stock')`;
}

/**
 * `shelfBeforeSql` for a set of cartons the caller already holds, in one
 * statement. The executor is REQUIRED: every caller gives cargo back from
 * inside its own transaction, on the rows it has locked (#714).
 */
export async function shelfBefore(
  exec: Db | Tx,
  batchId: string,
  boxIds: string[],
): Promise<Map<string, PlannableStatus>> {
  const out = new Map<string, PlannableStatus>();
  if (boxIds.length === 0) return out;
  const rows = (await exec.execute(sql`
    SELECT b.id, ${shelfBeforeSql('b', sql`${batchId}::uuid`)} AS back
      FROM boxes b
     WHERE b.id IN (${sql.join(
       boxIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
  `)) as unknown as { id: string; back: PlannableStatus }[];
  for (const row of rows) out.set(row.id, row.back);
  return out;
}

/**
 * Cartons grouped by the shelf each goes back to — one UPDATE per status,
 * never one per carton. A carton the map does not name goes back `in_stock`,
 * the fragment's own default.
 */
export function byShelf<T extends { id: string }>(
  rows: readonly T[],
  back: ReadonlyMap<string, PlannableStatus>,
): [PlannableStatus, T[]][] {
  const out: [PlannableStatus, T[]][] = [];
  for (const status of PLANNABLE_STATUSES) {
    const home = rows.filter((row) => (back.get(row.id) ?? 'in_stock') === status);
    if (home.length > 0) out.push([status, home]);
  }
  return out;
}
