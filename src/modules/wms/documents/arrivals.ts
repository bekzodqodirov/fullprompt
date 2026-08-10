import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, boxes, boxMovements } from '../../platform/db/schema';

/**
 * «Qaysi partiyada Qashqarga kelgan» — which truck brought this cargo to the
 * warehouse it is standing in, and when.
 *
 * The owner asked for it on the agent's approval sheet: a plan out of Kashgar
 * consolidates cargo that arrived there on several different trucks from Yiwu
 * and Guangzhou, and the agent judging the load wants to see it grouped the
 * way it came in.
 *
 * THE RULE, one sentence: a lot's arrival at a warehouse is the NEWEST
 * movement, over the lot's boxes standing there now, that moved a box INTO
 * that warehouse; if that movement is an unload, the truck is named, and
 * otherwise the cargo was received or carried here without one.
 *
 * Every clause of it is load-bearing, and the causes in the live database say
 * why:
 *
 * - «standing there now» (`current_warehouse_id`) is what keeps `batch_departed`
 *   out. That row is written with `to_warehouse_id = destination` while the
 *   box's own warehouse becomes NULL — a truck heading for Kashgar has already
 *   written its arrival row days before it arrives. An in-transit box has no
 *   warehouse, so it cannot be in the set at all.
 * - «moved INTO» (`from IS DISTINCT FROM to`) is what keeps `plan_approved`,
 *   `load_scan`, `crate_packed` and the rest out. They carry the box's own
 *   warehouse on BOTH sides — they are status changes, not journeys — and
 *   `plan_approved` is newer than the arrival for exactly the cargo this sheet
 *   is about, so without this clause every row would name the truck it is
 *   being planned ONTO.
 * - «if it is an unload» is what keeps `found_at_origin` from naming a truck.
 *   That box was declared missing in transit and then found still standing at
 *   the origin: it never rode the batch its movement points at.
 */

/**
 * The causes that mean "a truck brought this box here". `found_here` belongs
 * with them — the box did ride that truck, it was simply never scanned off it.
 */
const ARRIVED_ON_A_TRUCK = ['unload_scan', 'undocumented_transfer', 'found_here'];

/** One (lot, truck) pair: how many boxes it brought and when the first landed. */
export interface ArrivalRow {
  lotId: string;
  /** null = received or moved here, on no truck of ours. */
  batchCode: string | null;
  arrivedAt: Date;
  boxes: number;
}

/** What a document prints about one lot's arrival. */
export interface LotArrival {
  /** Every truck that brought part of this lot here, earliest first. */
  codes: string[];
  /** When the earliest of them landed — the day this cargo started standing here. */
  arrivedAt: Date;
}

/**
 * Fold the per-truck rows into one answer per lot.
 *
 * A lot split across two trucks is real — a client's goods reach the Chinese
 * warehouse over a week and leave on whatever is loading. The EARLIEST arrival
 * decides where the lot is grouped, because that is the day this cargo started
 * waiting and the order a consolidator ships in; the cell names every truck so
 * the split is not hidden.
 */
export function foldArrivals(rows: ArrivalRow[]): Map<string, LotArrival> {
  const byLot = new Map<string, ArrivalRow[]>();
  for (const row of rows) {
    byLot.set(row.lotId, [...(byLot.get(row.lotId) ?? []), row]);
  }
  const out = new Map<string, LotArrival>();
  for (const [lotId, lotRows] of byLot) {
    const sorted = [...lotRows].sort((a, b) => a.arrivedAt.getTime() - b.arrivedAt.getTime());
    out.set(lotId, {
      // A lot that came partly on a truck and partly on none names the trucks
      // it does have; the untrucked part is not a code and cannot be printed.
      codes: sorted.map((r) => r.batchCode).filter((c): c is string => Boolean(c)),
      arrivedAt: sorted[0]!.arrivedAt,
    });
  }
  return out;
}

/** One block of a document: everything that came in on the same truck. */
export interface ArrivalGroup<T> {
  /** The trucks that brought it, joined for print. Empty = came on none. */
  code: string;
  /** The earliest landing in the block, or null when there is no truck. */
  arrivedAt: Date | null;
  rows: T[];
}

/**
 * Order a document's rows the way the cargo came in.
 *
 * Trucks first, oldest landing at the top — that is both the answer to «qaysi
 * partiyada kelgan» and the order a consolidator ships in. Whatever arrived on
 * no truck of ours goes LAST: it is a real group (a client who delivered
 * straight to this warehouse) but it is not an answer to the question the
 * sheet is being read for.
 */
export function groupByArrival<T>(
  rows: T[],
  of: (row: T) => { arrival: LotArrival | undefined; within: string },
): ArrivalGroup<T>[] {
  const groups = new Map<string, ArrivalGroup<T> & { within: Map<T, string> }>();
  for (const row of rows) {
    const { arrival, within } = of(row);
    const code = arrival?.codes.join(', ') ?? '';
    let group = groups.get(code);
    if (!group) {
      group = { code, arrivedAt: null, rows: [], within: new Map() };
      groups.set(code, group);
    }
    group.rows.push(row);
    group.within.set(row, within);
    // A truckless group spans whatever dates its rows happen to carry, so it
    // is deliberately left undated rather than labelled with one of them.
    if (code && arrival && (!group.arrivedAt || arrival.arrivedAt < group.arrivedAt)) {
      group.arrivedAt = arrival.arrivedAt;
    }
  }
  return [...groups.values()]
    .sort((a, b) => {
      if (!a.code) return 1;
      if (!b.code) return -1;
      const at = a.arrivedAt?.getTime() ?? 0;
      const bt = b.arrivedAt?.getTime() ?? 0;
      return at === bt ? a.code.localeCompare(b.code) : at - bt;
    })
    .map((g) => ({
      code: g.code,
      arrivedAt: g.arrivedAt,
      rows: [...g.rows].sort((x, y) => (g.within.get(x) ?? '').localeCompare(g.within.get(y) ?? '')),
    }));
}

/**
 * Read the arrivals of these lots at this warehouse.
 *
 * ONE query for the whole sheet, never one per line — a plan carries up to 500
 * of them and a per-row aggregate on a list is how /accounting came to issue
 * 1,564 statements for one screen (#432, #526). Measured on the owner's data
 * against his fullest warehouse (3,603 boxes standing, no lot filter at all):
 * 57 ms.
 */
export async function arrivalsForLots(
  lotIds: string[],
  warehouseId: string,
): Promise<Map<string, LotArrival>> {
  if (lotIds.length === 0) return new Map();

  // The newest into-this-warehouse movement per box. DISTINCT ON is the only
  // shape that answers "the newest one" without a correlated subquery per box
  // (#152); `box_movements_box_idx` is (box_id, created_at), which is exactly
  // the order it wants.
  const newestPerBox = db
    .$with('arrivals')
    .as(
      db
        .selectDistinctOn([boxMovements.boxId], {
          boxId: boxMovements.boxId,
          lotId: boxes.lotId,
          cause: boxMovements.cause,
          refType: boxMovements.refType,
          refId: boxMovements.refId,
          createdAt: boxMovements.createdAt,
        })
        .from(boxMovements)
        .innerJoin(boxes, eq(boxes.id, boxMovements.boxId))
        .where(
          and(
            inArray(boxes.lotId, lotIds),
            eq(boxes.currentWarehouseId, warehouseId),
            eq(boxMovements.toWarehouseId, warehouseId),
            sql`${boxMovements.fromWarehouseId} IS DISTINCT FROM ${boxMovements.toWarehouseId}`,
            // A box in transit has not arrived. `current_warehouse_id` already
            // says so, and this says it a second way that survives whatever
            // cause gets added next year: `batch_departed` writes the
            // DESTINATION days before the truck reaches it, so a rule that
            // trusts `to_warehouse_id` alone announces every arrival early.
            sql`${boxMovements.toStatus} <> 'in_transit'`,
          ),
        )
        .orderBy(boxMovements.boxId, desc(boxMovements.createdAt), desc(boxMovements.id)),
    );

  const rows = await db
    .with(newestPerBox)
    .select({
      lotId: newestPerBox.lotId,
      // NULL for anything that did not ride a truck of ours — the join carries
      // the cause test, so one query answers both halves of the rule.
      batchCode: batches.code,
      arrivedAt: sql<Date>`min(${newestPerBox.createdAt})`,
      boxes: sql<number>`count(*)::int`,
    })
    .from(newestPerBox)
    .leftJoin(
      batches,
      and(
        eq(batches.id, newestPerBox.refId),
        eq(newestPerBox.refType, 'batch'),
        inArray(newestPerBox.cause, ARRIVED_ON_A_TRUCK),
      ),
    )
    .groupBy(newestPerBox.lotId, batches.code);

  return foldArrivals(
    rows.map((r) => ({
      lotId: r.lotId,
      batchCode: r.batchCode,
      arrivedAt: new Date(r.arrivedAt),
      boxes: Number(r.boxes),
    })),
  );
}
