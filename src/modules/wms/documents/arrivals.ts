import { and, desc, eq, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, boxes, boxMovements, receipts } from '../../platform/db/schema';
import { CLIENT_ACTIVE_STATUSES } from '../boxes/active';
import { arrivalKey, arrivalLabel, type ArrivalSource } from './arrival-label';

export { arrivalKey, arrivalLabel, type ArrivalSource, type LabelSource } from './arrival-label';

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
 * movement is an unload, the truck is named; if it is the prixod itself and
 * the prixod was received off a factory trip heading HERE, the trip is named
 * (docs/ZAVOD-YOPISH.md §5 — «shu zavoddan, shu mashinada»); and otherwise the
 * cargo was received or carried here without one.
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
 * The landing movement `am` (one of `ARRIVED_ON_A_TRUCK`, ref truck `batch`)
 * was not taken back: an office over-count that a later press below «arrived»
 * sent back to the origin's shelf (`found_at_origin` on the same truck, newer)
 * did not arrive after all (review money-1). One fragment for the count's
 * ledger and the unload's «already landed by this truck» — the second reader
 * that restated the causes without it refused over → undo → over for ever
 * (review deploy#8).
 */
export function notSentBackSql(am: string, batch: SQL): SQL {
  const m = sql.raw(am);
  return sql`NOT EXISTS (
    SELECT 1 FROM box_movements back
     WHERE back.box_id = ${m}.box_id AND back.ref_type = 'batch' AND back.ref_id = ${batch}
       AND back.cause = 'found_at_origin' AND (back.created_at, back.id) > (${m}.created_at, ${m}.id))`;
}

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

/**
 * The TASHKENT CALENDAR DAY of `landedHereAtSql` — what every «N kun» beside a
 * carton standing here counts from (R5: the office's day, never the UTC one,
 * or a landing at 00:30 Tashkent is yesterday's). One home for the cast the
 * dashboard's fill card and the stock-aging report each wrote by hand.
 */
export function landedHereDaySql(box: string): SQL {
  return sql`((${landedHereAtSql(box)}) AT TIME ZONE 'Asia/Tashkent')::date`;
}

/**
 * The prixod's movements that are the PRIXOD landing its own cartons — the
 * receipt itself, and the cartons `editLot`/`growLotInTx` add to a lot later
 * (`lot_edit_add`, ref the same receipt): a carton grown at the trip's
 * destination came off the same factory as the rest of the lot. Only these
 * may name a factory trip; `receipt_moved` is an office correction, not a
 * journey, and a receipt on a trip is refused it (`moveReceipt`).
 */
export const LANDED_BY_ITS_PRIXOD = ['receipt', 'lot_edit_add'];

/** The factory trip a prixod's landing names (`ArrivalSource`'s pickup half, minus the kind). */
export type ArrivalPickup = Omit<Extract<ArrivalSource, { kind: 'pickup' }>, 'kind'>;

/** One (lot, truck) pair: how many boxes it brought and when the first landed. */
export interface ArrivalRow {
  lotId: string;
  /** null = not brought by a batch of ours (a walk-in, a factory trip, a move). */
  batchCode: string | null;
  /** The same truck's id — absent where a caller only ever needed the code. */
  batchId?: string | null;
  /** The factory trip the prixod came off (0100), when it heads HERE — absent/null otherwise. */
  pickup?: ArrivalPickup | null;
  arrivedAt: Date;
  boxes: number;
}

/** What a row says it came on — a batch, a factory trip, or nothing nameable. */
function sourceOf(row: ArrivalRow): ArrivalSource | null {
  if (row.batchCode) return { kind: 'batch', id: row.batchId ?? null, code: row.batchCode };
  if (row.pickup) return { kind: 'pickup', ...row.pickup };
  return null;
}

/** What a document prints about one lot's arrival. */
export interface LotArrival {
  /** Every truck — batch or factory trip — that brought part of this lot here, earliest first. */
  codes: string[];
  /** The same trucks as values, index for index with `codes`. */
  sources: ArrivalSource[];
  /** The same trucks as printed (`arrivalLabel`), index for index with `codes`. */
  labels: string[];
  /**
   * The day this lot landed — THE DATE RULE: the date of the row behind
   * `sources[0]`, the earliest NAMED landing (a batch or a factory trip),
   * and the earliest row of any kind only when nothing is named. A lot whose
   * other half was walked into the warehouse in June must not date July's
   * truck to June, neither on its own row nor in the heading over everybody
   * else's cargo in that block — and a factory trip is a truck like any
   * other here: the half that came on it is dated by it.
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
    const named = sorted.flatMap((row) => {
      const source = sourceOf(row);
      return source ? [{ row, source }] : [];
    });
    out.set(lotId, {
      codes: named.map((n) => n.source.code),
      sources: named.map((n) => n.source),
      labels: named.map((n) => arrivalLabel(n.source)),
      // The date rule (`LotArrival.arrivedAt`): the earliest NAMED landing.
      arrivedAt: (named[0]?.row ?? sorted[0])!.arrivedAt,
    });
  }
  return out;
}

/** One block of a document: everything that came in on the same truck. */
export interface ArrivalGroup<T> {
  /** `arrivalKey` of the truck — one block per truck. Empty = came on none. */
  key: string;
  /** The truck's code. Empty = came on none. */
  code: string;
  /** The truck itself (as its earliest row in the block names it); null = came on none. */
  source: ArrivalSource | null;
  /**
   * A factory trip's DISTINCT factories among the block's rows, in stop
   * order — the truck called at two factories and the heading says so,
   * while each row still prints its own stop's factory. Empty for a batch.
   */
  factories: string[];
  /** The earliest landing in the block, or null when there is no truck. */
  arrivedAt: Date | null;
  rows: T[];
}

/**
 * The words over a block: a batch's code, or a trip's code · its factories
 * («A, B») · its plate — `arrivalLabel` with the block's factories in the
 * factory's place, so the heading and the row cells cannot spell a trip two
 * ways.
 */
export function arrivalBlockLabel(group: Pick<ArrivalGroup<unknown>, 'source' | 'factories'>): string {
  const source = group.source;
  if (!source) return '';
  if (source.kind === 'batch') return arrivalLabel(source);
  return arrivalLabel({ ...source, factory: group.factories.join(', ') });
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
  const groups = new Map<
    string,
    ArrivalGroup<T> & { within: Map<T, string>; stops: Map<string, number> }
  >();
  for (const row of rows) {
    const { arrival, within } = of(row);
    // The EARLIEST truck, not the joined list. Keyed on the list, a lot that
    // came half on KAS-012 and half on KAS-020 forms a THIRD block of its own,
    // so KAS-012's cargo appears in two places with two subtotals to add up by
    // hand — on a sheet whose whole promise is one block per truck. And keyed
    // on the truck's IDENTITY (`arrivalKey`), never its code string: a factory
    // trip's two stops are one truck, so one block.
    const source = arrival?.sources[0] ?? null;
    const key = arrivalKey(source);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        code: source?.code ?? '',
        source,
        factories: [],
        arrivedAt: null,
        rows: [],
        within: new Map(),
        stops: new Map(),
      };
      groups.set(key, group);
    }
    group.rows.push(row);
    group.within.set(row, within);
    // Each factory at its earliest stop on the trip, for the heading's order.
    if (source?.kind === 'pickup') {
      const seq = group.stops.get(source.factory);
      if (seq === undefined || source.seq < seq) group.stops.set(source.factory, source.seq);
    }
    // A truckless group spans whatever dates its rows happen to carry, so it
    // is deliberately left undated rather than labelled with one of them.
    if (key && arrival && (!group.arrivedAt || arrival.arrivedAt < group.arrivedAt)) {
      group.arrivedAt = arrival.arrivedAt;
    }
  }
  return [...groups.values()]
    .sort((a, b) => {
      if (!a.key) return 1;
      if (!b.key) return -1;
      const at = a.arrivedAt?.getTime() ?? 0;
      const bt = b.arrivedAt?.getTime() ?? 0;
      return at === bt ? a.code.localeCompare(b.code) || a.key.localeCompare(b.key) : at - bt;
    })
    .map((g) => ({
      key: g.key,
      code: g.code,
      source: g.source,
      factories: [...g.stops].sort((x, y) => x[1] - y[1] || x[0].localeCompare(y[0])).map(([name]) => name),
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
  /**
   * The BATCHES that brought it, earliest first — batches only, because this
   * feeds `cargoTrucks` (a factory trip is not a batch and has no batch
   * card). NOT index-aligned with `codes` once a trip stands among them:
   * pair a code with its truck through `sources`.
   */
  batchIds: string[];
  since: Date;
}

/**
 * `foldArrivals`, plus the two facts `PairArrival` adds — pure, for the tests.
 *
 * The rows are grouped by lot ONCE: it sits under `arrivalLabelsForPairs`, so
 * /stock, its XLSX and the bot pay for it on every read, and a filter over
 * every row per lot is quadratic in the fullest warehouse. Each lot's own
 * rows then go through `foldArrivals` itself, so `codes`, `sources` and
 * `arrivedAt` keep their one home; `batchIds` is the batch half of `sources`.
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
      batchIds: arrival.sources.flatMap((s) => (s.kind === 'batch' ? [s.id ?? ''] : [])),
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

/**
 * The LABELS of `arrivalsForPairs` — what the stock table, its XLSX and the
 * bot print: a batch's code, a factory trip's «ZR-… · factory · plate». It
 * was `arrivalCodesForPairs` while only a batch could be named, and was
 * renamed when what it returns changed, so no reader takes a label for a
 * code (a code is a lookup key; a label is not).
 */
export async function arrivalLabelsForPairs(
  pairs: { lotId: string; warehouseId: string }[],
): Promise<Map<string, string[]>> {
  const arrivals = await arrivalsForPairs(pairs);
  return new Map([...arrivals].map(([key, arrival]) => [key, arrival.labels]));
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
      // The factory trip: NULL unless the landing is the prixod's own and the
      // prixod came off a trip heading HERE (the nested join below). Only
      // columns that predate 0133 — this read has callers that do not catch,
      // and on a deploy morning one migration behind they must not 42703.
      pickupId: sql<string | null>`p.id`,
      pickupCode: sql<string | null>`p.code`,
      pickupPlate: sql<string | null>`p.vehicle_plate`,
      stopId: sql<string | null>`ps.id`,
      stopSeq: sql<number | null>`ps.seq`,
      factory: sql<string | null>`f.name`,
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
    .leftJoin(
      receipts,
      and(
        eq(receipts.id, newestPerBox.refId),
        eq(newestPerBox.refType, 'receipt'),
        inArray(newestPerBox.cause, LANDED_BY_ITS_PRIXOD),
      ),
    )
    // Stop, trip and factory joined INSIDE one parenthesised join, so a row
    // carries all three or none — never a factory beside a NULL trip. The
    // destination guard is the trip's own claim about where it was going: a
    // prixod moved or linked to a trip bound for another warehouse (or a lot
    // grown at a truck's origin, `growLotInTx`) is not that trip's cargo
    // HERE. The trip's status is deliberately not read — a closed trip keeps
    // naming the cargo it brought.
    .leftJoin(
      sql`(pickup_stops ps
        JOIN pickups p ON p.id = ps.pickup_id AND p.dest_warehouse_id = ${warehouseId}::uuid
        JOIN factories f ON f.id = ps.factory_id)`,
      sql`ps.id = ${receipts.pickupStopId}`,
    )
    .groupBy(
      newestPerBox.lotId,
      batches.code,
      batches.id,
      sql`p.id`,
      sql`p.code`,
      sql`p.vehicle_plate`,
      sql`ps.id`,
      sql`ps.seq`,
      sql`f.name`,
    );

  return rows.map((r) => ({
    lotId: r.lotId,
    batchCode: r.batchCode,
    batchId: r.batchId,
    pickup:
      r.pickupId && r.pickupCode && r.stopId
        ? {
            id: r.pickupId,
            code: r.pickupCode,
            stopId: r.stopId,
            seq: Number(r.stopSeq),
            factory: r.factory ?? '',
            plate: r.pickupPlate,
          }
        : null,
    arrivedAt: new Date(r.arrivedAt),
    boxes: Number(r.boxes),
  }));
}
