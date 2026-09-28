import { and, desc, eq, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, boxes, boxMovements } from '../../platform/db/schema';
import { CLIENT_ACTIVE_STATUSES } from '../boxes/active';

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
 * movement, over the lot's boxes, that LANDED a box in that warehouse; if that
 * movement is an unload, the truck is named, and otherwise the cargo was
 * received or carried here without one.
 *
 * Every clause of it is load-bearing, and the causes in the live database say
 * why:
 *
 * - «landed» (`to_status <> 'in_transit'`) is what keeps `batch_departed` out.
 *   That row is written with `to_warehouse_id = destination` the moment a
 *   truck LEAVES, so a rule trusting `to_warehouse_id` alone announces every
 *   arrival days early. The box's own `current_warehouse_id` answers the same
 *   question and is deliberately not asked: `departBatch` nulls it, so the
 *   sheet would stop naming any truck the moment the plan's own truck left.
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
export const ARRIVED_ON_A_TRUCK = ['unload_scan', 'undocumented_transfer', 'found_here'];

/**
 * «This movement landed the box in THIS warehouse» — the three clauses above,
 * as one fragment, so the second reader of the rule cannot restate two of
 * them (#513).
 *
 * `found_at_origin` is excluded here and was not excluded in the paragraph
 * above, because the document only ever used the rule to NAME A TRUCK and
 * that cause is simply absent from `ARRIVED_ON_A_TRUCK`. A caller asking
 * «when did this box get here» is asking a different question, and that
 * movement is a box which never left: `departBatch` has already NULLed
 * `current_warehouse_id`, so `NULL IS DISTINCT FROM origin` is TRUE and the
 * row passes every other clause while describing a journey that did not
 * happen. Latent in this file too — kept in one place so it stays fixed.
 */
export function landedHereSql(warehouseIdCol: SQL | SQLWrapper): SQL {
  return sql`${boxMovements.toWarehouseId} = ${warehouseIdCol}
    AND ${boxMovements.fromWarehouseId} IS DISTINCT FROM ${boxMovements.toWarehouseId}
    AND ${boxMovements.toStatus} <> 'in_transit'
    AND ${boxMovements.cause} <> 'found_at_origin'`;
}

/**
 * WHEN a landing movement put the box here — the clock of «how long has it
 * been standing here», stated once for every reader.
 *
 * A walk-in (`cause = 'receipt'`) is dated by the day the goods came in, not
 * the minute the office typed them: an office prixod may be entered up to a
 * week late (0112, Q9b — review cargo-7), and its movement carries the typing
 * minute while `receipts.received_at` carries the day. Every other landing is
 * its own movement's clock. Reads the `box_movements` row in scope (qualified
 * or not, #128) and the box's lot through `lotIdCol`.
 *
 * `warehouseFill`'s two inline copies of the landing rule never learned the
 * walk-in half, so an office prixod at Tashkent typed six days late read
 * «0 kun» on the dashboard while the agent sheet dated it right (#513).
 */
export function landingInstantSql(lotIdCol: SQL | SQLWrapper): SQL {
  return sql`CASE WHEN ${boxMovements.cause} = 'receipt'
    THEN coalesce((
      SELECT ar.received_at FROM receipt_lots arl JOIN receipts ar ON ar.id = arl.receipt_id
       WHERE arl.id = ${lotIdCol}
    ), ${boxMovements.createdAt})
    ELSE ${boxMovements.createdAt} END`;
}

/**
 * When the box standing in its warehouse landed THERE: the newest movement
 * that passes `landedHereSql` for the box's own `current_warehouse_id`, dated
 * by `landingInstantSql`. A scalar subquery over the outer boxes row `box`
 * (an alias — `b`, or `"boxes"` in a builder query).
 *
 * `box_movements` is deliberately left UNALIASED inside: drizzle renders the
 * helpers' columns unqualified in a single-table select (#128), and an
 * unqualified name binds to the innermost FROM — which is this one, and not
 * the outer query's table. No fallback for a box with no landing at all: the
 * receipt writes a movement from a NULL warehouse, so there is always one
 * (#845); a box with none reads NULL and is dated by nobody rather than by its
 * China receipt.
 */
export function landedHereAtSql(box: string): SQL {
  const b = sql.raw(box);
  return sql`(SELECT ${landingInstantSql(sql`${b}.lot_id`)}
      FROM ${boxMovements}
     WHERE ${boxMovements.boxId} = ${b}.id
       AND ${landedHereSql(sql`${b}.current_warehouse_id`)}
     ORDER BY ${boxMovements.createdAt} DESC, ${boxMovements.id} DESC
     LIMIT 1)`;
}

/** One (lot, truck) pair: how many boxes it brought and when the first landed. */
export interface ArrivalRow {
  lotId: string;
  /** null = received or moved here, on no truck of ours. */
  batchCode: string | null;
  /** The same truck's id — absent where a caller only ever needed the code. */
  batchId?: string | null;
  arrivedAt: Date;
  boxes: number;
}

/** What a document prints about one lot's arrival. */
export interface LotArrival {
  /** Every truck that brought part of this lot here, earliest first. */
  codes: string[];
  /**
   * The day this lot landed. The earliest TRUCKED landing when there is one,
   * and the earliest arrival of any kind when there is not — a lot whose other
   * half was walked into the warehouse in June must not date July's truck to
   * June, neither on its own row nor in the heading over everybody else's
   * cargo in that block.
   */
  arrivedAt: Date;
}

/**
 * Fold the per-truck rows into one answer per lot.
 *
 * A lot split across two trucks is real — a client's goods reach the Chinese
 * warehouse over a week and leave on whatever is loading. The EARLIEST TRUCK
 * decides where the lot is grouped, because that is the order a consolidator
 * ships in; the row cell names every truck, which is the only place the split
 * is visible at all.
 */
export function foldArrivals(rows: ArrivalRow[]): Map<string, LotArrival> {
  const byLot = new Map<string, ArrivalRow[]>();
  for (const row of rows) {
    byLot.set(row.lotId, [...(byLot.get(row.lotId) ?? []), row]);
  }
  const out = new Map<string, LotArrival>();
  for (const [lotId, lotRows] of byLot) {
    const sorted = [...lotRows].sort((a, b) => a.arrivedAt.getTime() - b.arrivedAt.getTime());
    // A lot that came partly on a truck and partly on none names the trucks it
    // does have; the untrucked part is not a code and cannot be printed.
    const trucked = sorted.filter((r) => r.batchCode);
    out.set(lotId, {
      codes: trucked.map((r) => r.batchCode!),
      arrivedAt: (trucked[0] ?? sorted[0])!.arrivedAt,
    });
  }
  return out;
}

/** One block of a document: everything that came in on the same truck. */
export interface ArrivalGroup<T> {
  /** The truck that brought it. Empty = came on none. */
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
    // The EARLIEST truck, not the joined list. Keyed on the list, a lot that
    // came half on KAS-012 and half on KAS-020 forms a THIRD block of its own,
    // so KAS-012's cargo appears in two places with two subtotals to add up by
    // hand — on a sheet whose whole promise is one block per truck.
    const code = arrival?.codes[0] ?? '';
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
 * One (lot, warehouse) pair's arrival, with what the codes alone could not
 * carry: the trucks' ids (a link is asked of the truck card's door, which
 * needs the truck) and `since` — the EARLIEST landing of any kind among the
 * boxes read, i.e. how long the carton that has waited longest has waited.
 *
 * `since` is not `arrivedAt`. `arrivedAt` is the document's date (the earliest
 * TRUCKED landing, so a walk-in half does not back-date a truck's block);
 * «how many days has this stood here» is a question about every carton, and a
 * walk-in carton that has stood here a month has waited a month.
 */
export interface PairArrival extends LotArrival {
  /** The trucks that brought it, in the order of `codes`. */
  batchIds: string[];
  since: Date;
}

/**
 * `foldArrivals`, plus the two facts `PairArrival` adds — pure, for the tests.
 *
 * The rows are grouped by lot ONCE: it sits under `arrivalCodesForPairs`, so
 * /stock, its XLSX and the bot pay for it on every read, and a filter over
 * every row per lot is quadratic in the fullest warehouse. Each lot's own
 * rows then go through `foldArrivals` itself, so `codes` and `arrivedAt` keep
 * their one home, and `batchIds` is sorted by the same stable comparator over
 * the same rows — it lines up with `codes` index for index.
 */
export function foldPairArrivals(rows: ArrivalRow[]): Map<string, PairArrival> {
  const byLot = new Map<string, ArrivalRow[]>();
  for (const row of rows) {
    const own = byLot.get(row.lotId);
    if (own) own.push(row);
    else byLot.set(row.lotId, [row]);
  }
  const out = new Map<string, PairArrival>();
  for (const [lotId, own] of byLot) {
    const arrival = foldArrivals(own).get(lotId)!;
    const sorted = [...own].sort((a, b) => a.arrivedAt.getTime() - b.arrivedAt.getTime());
    out.set(lotId, {
      ...arrival,
      batchIds: sorted.filter((r) => r.batchCode).map((r) => r.batchId ?? ''),
      since: sorted[0]!.arrivedAt,
    });
  }
  return out;
}

/**
 * «Qaysi partiyada kelgan», for rows that span WAREHOUSES — the stock table
 * groups by (lot, warehouse) and a lot standing in two places arrived on two
 * different answers. One `arrivalRowsForLots` call per distinct warehouse
 * (bounded by the nine he has), never one per row (#432), keyed
 * `lotId|warehouseId`.
 *
 * `standing` reads only the cartons that are STILL here and still ours. The
 * plain read asks about every carton of the lot that ever landed here, which
 * is right for «which truck brought this lot» and wrong for «how long has
 * what stands here waited»: a lot whose first half landed thirty days ago and
 * was handed over, and whose second half landed three days ago, read «30 kun»
 * about cartons that arrived on Tuesday (the client card «Yuklar» tab's judge,
 * finding 2 — 21 of 3,981 standing pairs on the shaped copy, and unbounded in
 * general).
 */
export async function arrivalsForPairs(
  pairs: { lotId: string; warehouseId: string }[],
  opts: { standing?: boolean } = {},
): Promise<Map<string, PairArrival>> {
  const byWh = new Map<string, Set<string>>();
  for (const { lotId, warehouseId } of pairs) {
    byWh.set(warehouseId, (byWh.get(warehouseId) ?? new Set()).add(lotId));
  }
  const out = new Map<string, PairArrival>();
  for (const [warehouseId, lotIds] of byWh) {
    const arrivals = foldPairArrivals(await arrivalRowsForLots([...lotIds], warehouseId, opts));
    for (const [lotId, arrival] of arrivals) {
      out.set(`${lotId}|${warehouseId}`, arrival);
    }
  }
  return out;
}

/** The codes of `arrivalsForPairs` — what the stock table, its XLSX and the bot print. */
export async function arrivalCodesForPairs(
  pairs: { lotId: string; warehouseId: string }[],
): Promise<Map<string, string[]>> {
  const arrivals = await arrivalsForPairs(pairs);
  return new Map([...arrivals].map(([key, arrival]) => [key, arrival.codes]));
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
  return foldArrivals(await arrivalRowsForLots(lotIds, warehouseId));
}

/**
 * The per-truck rows `arrivalsForLots` folds — its query, exported so the pair
 * read can fold the same rows its own way. `standing`: see `arrivalsForPairs`.
 */
export async function arrivalRowsForLots(
  lotIds: string[],
  warehouseId: string,
  opts: { standing?: boolean } = {},
): Promise<ArrivalRow[]> {
  if (lotIds.length === 0) return [];

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
          // A walk-in is dated by the day the goods came in, not the minute
          // the office typed them — the clock's one home (`landingInstantSql`).
          createdAt: sql<Date>`${landingInstantSql(boxes.lotId)}`.as('landed_at'),
        })
        .from(boxMovements)
        .innerJoin(boxes, eq(boxes.id, boxMovements.boxId))
        .where(
          and(
            inArray(boxes.lotId, lotIds),
            // The rule itself, from its one home — the comment above spells
            // out what each clause keeps out.
            landedHereSql(sql`${warehouseId}::uuid`),
            // Only what still stands HERE and is still ours (see
            // `arrivalsForPairs`): a carton handed over or moved on does not
            // date the ones left behind.
            opts.standing
              ? and(
                  eq(boxes.currentWarehouseId, warehouseId),
                  inArray(boxes.status, [...CLIENT_ACTIVE_STATUSES]),
                )
              : undefined,
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
      batchId: batches.id,
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
    .groupBy(newestPerBox.lotId, batches.code, batches.id);

  return rows.map((r) => ({
    lotId: r.lotId,
    batchCode: r.batchCode,
    batchId: r.batchId,
    arrivedAt: new Date(r.arrivedAt),
    boxes: Number(r.boxes),
  }));
}
