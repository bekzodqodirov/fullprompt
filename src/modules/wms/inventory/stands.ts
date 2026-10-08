import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { THREAD_UUID } from '../../platform/notifications/thread-ref';
import { CLIENT_ACTIVE_STATUSES } from '../boxes/active';
import type { BatchEnds } from '../batches/card-door';
import { awaitingUnloadCounts } from '../scanning/unload';

/**
 * WHERE THE CARGO STANDS NOW — the one home of the rule a prixod's or a
 * truck's staff thread is built on (round 2, the owner's E6 c / E7 b / Q4 a,
 * 2026-10-07: «yuk hozir turgan sklad», never `receipts.warehouse_id`).
 *
 * Read by the thread door (who may read), the audience (whose staff hear a
 * question), the ping's «📍» line, the card panel's line and the dock — a
 * surface that restates it is the leak (cargo-thread-wire K6).
 *
 * At the moment it is computed it is a STRICT SUBSET of the card doors —
 * `cargoNearActor ∪ receiving warehouse` for a prixod (receipts/read-door.ts),
 * `{origin, dest}` for a truck (batches/card-door.ts) — so a person it reaches
 * passes the card's door and a ping's link does not bounce WHEN IT IS SENT.
 * It is not a promise about later: once the cargo moves on, an older ping to
 * a warehouse the card no longer admits opens a 404 (stated, a known limit).
 *
 * The LIVE pointers, never `box_movements`: «where does it stand now» is the
 * one question the live pointer answers by construction (#440 bites a truck's
 * membership and a carton's history, not this).
 */

/** How a carton riding a truck is spoken of — from the TRUCK's status, never the audience stage. */
export type RoadWord = 'road' | 'unloading' | 'missing';
/** How the truck card's cargo is spoken of — its own state, separate from who it reaches. */
export type TruckWord = 'loading' | 'cancelled' | 'road' | 'unloading' | 'missing' | 'arrived';
/** WHO a truck thread reaches — the audience. Never used for words (`truckWordOf` is). */
export type TruckStage = 'origin' | 'road' | 'dest';

export type CargoPlace =
  /** A live carton on a shelf — in stock, ready for pickup, or planned/loading (still on the origin shelf). */
  | { kind: 'shelf'; warehouseId: string; boxes: number }
  /** A live carton riding a truck (no shelf, by the pointer invariant `in_transit`) — both ends answer. */
  | {
      kind: 'road';
      batchId: string;
      originWarehouseId: string;
      destWarehouseId: string;
      truckStatus: string;
      boxes: number;
    }
  /** Fallback 1: nothing live — the warehouse that handed it over holds the act. */
  | { kind: 'issued'; warehouseId: string; boxes: number }
  /** Fallback 1: nothing live — written off ON A SHELF (the stocktake, the box-lost door). */
  | { kind: 'lost'; warehouseId: string; boxes: number }
  /** Fallback 2: nothing live, issued or shelf-lost — the people who received (or voided) it. */
  | { kind: 'received'; warehouseId: string; receiptStatus: 'draft' | 'confirmed' | 'voided' }
  /** The truck card's own cargo: its stage, its status and what is still aboard. */
  | {
      kind: 'truck';
      stage: TruckStage;
      status: string;
      aboard: number;
      originWarehouseId: string;
      destWarehouseId: string;
    };

export interface CargoStand {
  /** The warehouses whose staff the question reaches and the thread door admits — deduplicated, first-seen order. */
  warehouseIds: string[];
  /** Why each one is there — for the words (`cargoNowLine`). */
  places: CargoPlace[];
}

/** The order the places are spoken in: what stands on a shelf, then what rides, then the fallbacks. */
const PLACE_RANK: Record<CargoPlace['kind'], number> = {
  shelf: 0,
  road: 1,
  issued: 2,
  lost: 3,
  received: 4,
  truck: 5,
};

function placeWarehouses(place: CargoPlace): string[] {
  switch (place.kind) {
    case 'shelf':
    case 'issued':
    case 'lost':
    case 'received':
      return [place.warehouseId];
    case 'road':
      return [place.originWarehouseId, place.destWarehouseId];
    case 'truck':
      return place.stage === 'origin'
        ? [place.originWarehouseId]
        : place.stage === 'road'
          ? [place.originWarehouseId, place.destWarehouseId]
          : [place.destWarehouseId];
    default: {
      const never: never = place;
      return never;
    }
  }
}

/** Pure: the stand a list of places makes. */
export function standOf(places: readonly CargoPlace[]): CargoStand {
  const warehouseIds: string[] = [];
  for (const place of places) {
    for (const id of placeWarehouses(place)) if (!warehouseIds.includes(id)) warehouseIds.push(id);
  }
  return { warehouseIds, places: [...places] };
}

/**
 * Pure: the truck's AUDIENCE stage from its own row and how many cartons
 * still ride it (`awaitingUnloadCounts`, the unload screen's own counter —
 * the cartons being unloaded AND the unresolved declared-missing ones, both
 * `in_transit` on this truck). An arrived truck with cartons aboard and an
 * unloaded one with a missing carton reach BOTH ends: the loader may answer
 * «found at origin», the receiver is counting. Unknown = no stand.
 */
export function truckStageOf(status: string, aboard: number): TruckStage | null {
  switch (status) {
    case 'forming':
    case 'loading':
    case 'cancelled':
      // The cargo is on — or, cancelled, back on — the origin shelf.
      return 'origin';
    case 'in_transit':
      return 'road';
    case 'arrived':
    case 'unloaded':
    case 'closed':
      return aboard > 0 ? 'road' : 'dest';
    default:
      return null;
  }
}

/**
 * Pure: the truck's WORDS — the same two inputs, a finer answer. A truck
 * emptied at its dock is not «on the road», and an arrived truck being
 * unloaded stands at its destination even while both ends still hear it.
 */
export function truckWordOf(status: string, aboard: number): TruckWord | null {
  switch (status) {
    case 'forming':
    case 'loading':
      return 'loading';
    case 'cancelled':
      return 'cancelled';
    case 'in_transit':
      return 'road';
    case 'arrived':
      return aboard > 0 ? 'unloading' : 'arrived';
    case 'unloaded':
    case 'closed':
      // Still «aboard» after the unload = declared missing and unresolved.
      return aboard > 0 ? 'missing' : 'arrived';
    default:
      return null;
  }
}

/** Pure: a carton riding a truck of this status. */
export function roadWordOf(truckStatus: string): RoadWord {
  if (truckStatus === 'arrived') return 'unloading';
  if (truckStatus === 'unloaded' || truckStatus === 'closed') return 'missing';
  return 'road';
}

/** Pure: the truck's stand — origin → [origin]; road → [origin, dest]; dest → [dest]; unknown → no stand. */
export function truckStand(
  batch: { status: string; originWarehouseId: string; destWarehouseId: string },
  aboard: number,
): CargoStand {
  const stage = truckStageOf(batch.status, aboard);
  if (stage === null) return { warehouseIds: [], places: [] };
  return standOf([
    {
      kind: 'truck',
      stage,
      status: batch.status,
      aboard,
      originWarehouseId: batch.originWarehouseId,
      destWarehouseId: batch.destWarehouseId,
    },
  ]);
}

const idList = (ids: readonly string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);

function cleanIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => THREAD_UUID.test(id)).map((id) => id.toLowerCase()))];
}

/**
 * Where each of these prixods stands NOW, plus its receiving warehouse (the
 * card door's first arm). Two statements whatever the count.
 *
 * The rule:
 *   1. over the prixod's LIVE cartons (`CLIENT_ACTIVE_STATUSES`) that are
 *      PLACEABLE: a carton with a shelf stands at that shelf — in stock,
 *      ready, AND planned/loading (still on the origin shelf, so a planned
 *      carton does NOT reach its truck's destination, the widening
 *      `cargoNearActor` has); a carton with no shelf (exactly an in-transit
 *      one) stands at BOTH ends of its live truck (a reroute followed for
 *      free — the live `dest_warehouse_id`);
 *   2. nothing live: where cartons were ISSUED (the handover warehouse holds
 *      the act) or written off ON A SHELF (the people who counted them lost);
 *   3. nothing of either: the receiving warehouse. A ROAD-lost carton is never
 *      followed to its road-loss truck — that truck's ends are outside the
 *      card's door, and its staff would be handed a link that 404s.
 * The fallbacks apply only when the live set is EMPTY: three cartons on a
 * shelf and 97 issued asks the shelf.
 */
export async function receiptStands(
  receiptIds: readonly string[],
): Promise<Map<string, { receivingWarehouseId: string; stand: CargoStand }>> {
  const out = new Map<string, { receivingWarehouseId: string; stand: CargoStand }>();
  const ids = cleanIds(receiptIds);
  if (ids.length === 0) return out;
  const live = sql.join(
    CLIENT_ACTIVE_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  const [heads, rows] = await Promise.all([
    db.execute<{ id: string; warehouse_id: string; receipt_status: string }>(sql`
      SELECT r.id::text AS id, r.warehouse_id::text AS warehouse_id, r.status AS receipt_status
        FROM receipts r WHERE r.id IN (${idList(ids)})
    `),
    db.execute<{
      receipt_id: string;
      kind: string;
      warehouse_id: string | null;
      batch_id: string | null;
      origin_id: string | null;
      dest_id: string | null;
      truck_status: string | null;
      boxes: number | string;
    }>(sql`
      WITH live AS (
        SELECT l.receipt_id, b.current_warehouse_id, b.current_batch_id
          FROM receipt_lots l
          JOIN boxes b ON b.lot_id = l.id
         WHERE l.receipt_id IN (${idList(ids)})
           AND b.status IN (${live})
           -- Placeable: a live carton with neither a shelf nor a truck (an
           -- invariant measured never to break) is NOT live here, so it cannot
           -- hide the fallbacks behind it.
           AND (b.current_warehouse_id IS NOT NULL OR b.current_batch_id IS NOT NULL)
      )
      SELECT live.receipt_id::text AS receipt_id, 'shelf' AS kind, live.current_warehouse_id::text AS warehouse_id,
             NULL::text AS batch_id, NULL::text AS origin_id, NULL::text AS dest_id, NULL::text AS truck_status,
             count(*)::int AS boxes
        FROM live WHERE live.current_warehouse_id IS NOT NULL
       GROUP BY live.receipt_id, live.current_warehouse_id
      UNION ALL
      SELECT live.receipt_id::text, 'road', NULL, t.id::text, t.origin_warehouse_id::text, t.dest_warehouse_id::text,
             t.status, count(*)::int
        FROM live JOIN batches t ON t.id = live.current_batch_id
       WHERE live.current_warehouse_id IS NULL
       GROUP BY live.receipt_id, t.id, t.origin_warehouse_id, t.dest_warehouse_id, t.status
      UNION ALL
      SELECT l.receipt_id::text, b.status, b.current_warehouse_id::text, NULL, NULL, NULL, NULL, count(*)::int
        FROM receipt_lots l JOIN boxes b ON b.lot_id = l.id
       WHERE l.receipt_id IN (${idList(ids)}) AND b.status IN ('issued', 'lost') AND b.current_warehouse_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM live WHERE live.receipt_id = l.receipt_id)
       GROUP BY l.receipt_id, b.status, b.current_warehouse_id
      ORDER BY 1, 2, 8 DESC
    `),
  ]);
  const placesOf = new Map<string, CargoPlace[]>();
  for (const row of rows) {
    const boxes = Number(row.boxes);
    let place: CargoPlace | null = null;
    if (row.kind === 'shelf' && row.warehouse_id) place = { kind: 'shelf', warehouseId: row.warehouse_id, boxes };
    else if (row.kind === 'road' && row.batch_id && row.origin_id && row.dest_id) {
      place = {
        kind: 'road',
        batchId: row.batch_id,
        originWarehouseId: row.origin_id,
        destWarehouseId: row.dest_id,
        truckStatus: row.truck_status ?? '',
        boxes,
      };
    } else if ((row.kind === 'issued' || row.kind === 'lost') && row.warehouse_id) {
      place = { kind: row.kind, warehouseId: row.warehouse_id, boxes };
    }
    if (place) placesOf.set(row.receipt_id, [...(placesOf.get(row.receipt_id) ?? []), place]);
  }
  for (const head of heads) {
    const found = placesOf.get(head.id);
    const places: CargoPlace[] =
      found && found.length > 0
        ? [...found].sort((a, b) => PLACE_RANK[a.kind] - PLACE_RANK[b.kind] || boxesOf(b) - boxesOf(a))
        : [
            {
              kind: 'received',
              warehouseId: head.warehouse_id,
              receiptStatus:
                head.receipt_status === 'draft' || head.receipt_status === 'voided' ? head.receipt_status : 'confirmed',
            },
          ];
    out.set(head.id, { receivingWarehouseId: head.warehouse_id, stand: standOf(places) });
  }
  return out;
}

function boxesOf(place: CargoPlace): number {
  return 'boxes' in place ? place.boxes : 0;
}

/**
 * Where each of these trucks' cargo stands NOW: the truck's own row and ONE
 * count, `awaitingUnloadCounts` — the unload screen's counter rather than a
 * restated LATERAL (#513 is worth one statement). Two statements.
 */
export async function batchStands(
  batchIds: readonly string[],
): Promise<Map<string, { ends: BatchEnds; status: string; stand: CargoStand }>> {
  const out = new Map<string, { ends: BatchEnds; status: string; stand: CargoStand }>();
  const ids = cleanIds(batchIds);
  if (ids.length === 0) return out;
  const [rows, aboard] = await Promise.all([
    db.execute<{ id: string; status: string; origin_id: string; dest_id: string }>(sql`
      SELECT t.id::text AS id, t.status, t.origin_warehouse_id::text AS origin_id, t.dest_warehouse_id::text AS dest_id
        FROM batches t WHERE t.id IN (${idList(ids)})
    `),
    awaitingUnloadCounts(ids),
  ]);
  for (const row of rows) {
    const ends = { originWarehouseId: row.origin_id, destWarehouseId: row.dest_id };
    out.set(row.id, {
      ends,
      status: row.status,
      stand: truckStand({ status: row.status, ...ends }, aboard.get(row.id) ?? 0),
    });
  }
  return out;
}
