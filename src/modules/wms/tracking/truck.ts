import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clients,
  receiptLots,
  receipts,
} from '../../platform/db/schema';
import { isMovingStage, stageBatchOf, truckStage } from '../client-cabinet/stages';
import { placeDated, placeTruck, type BorderHours } from './eta';
import { WAREHOUSE_POINTS } from './map-data';
import { placementFix, type LatestPosition } from './devices';
import { gateDaysOf, stuckAtPhoneGate } from './on-road-state';
import { tashkentDay } from '../../platform/time/tashkent';

/** The marker /map draws — structurally the component's MapTruck. */
export interface TruckMarker {
  batchId: string;
  code: string;
  originCode: string;
  destCode: string;
  /** lon */
  x: number;
  /** lat */
  y: number;
  /**
   * Something honest places the truck (`placeTruck`'s point): false for a
   * truck past its whole schedule that nothing but its departure places —
   * the spent walk ends ON the destination warehouse, and a lorry drawn there
   * reads «arrived». x/y are then meaningless: /map leaves it off the canvas
   * and names it under the map, the cabinet map lists it with no point.
   */
  placed: boolean;
  /**
   * The phone has it at its destination's gate (`placeTruck`): the popup and
   * the bot say «at the gate, not unloaded» — never late on the road and
   * never «call the driver» (the recheck); how long it has stood is
   * `gateDays`.
   */
  atGate: boolean;
  /** At the gate: Tashkent days since the phone first put it there (`gateDaysOf`); null elsewhere. */
  gateDays: number | null;
  /** Standing there unloaded past the stuck days (`stuckAtPhoneGate`): the popup and the bot say «check the unloading». */
  gateStuck: boolean;
  /** A fresh fix from the driver's phone places the truck — the dot is the fix. */
  live: boolean;
  fixAgeMinutes: number | null;
  fixSource: string | null;
  segKey: string;
  /** The road's LENGTH behind it (4a); null = nobody can say (no road, or overdue with nothing but the departure). */
  progress: number | null;
  overdue: boolean;
  remainingDays: [number, number];
  /**
   * A date may be printed beside this truck: it is placed, not overdue, and
   * on a rung the customer is shown a date for (O15 — a truck the logist
   * pinned in Uzbekistan has no date in the cabinet, so none on the map, in
   * the bot or on the cabinet map either).
   */
  dated: boolean;
  departedAt: string;
  checkpointKey: string | null;
  vehiclePlate: string | null;
  routePoints: { x: number; y: number }[];
  contents: { clientCode: string; n: number }[];
}

/** A truck's two ends, as the placement reads them. */
export interface TruckEnds {
  originCode: string;
  destCode: string;
  originCountry: string | null;
  destCountry: string | null;
}

/**
 * Estimate + contents for one in-transit batch (null = not on the map).
 *
 * A REAL fix from the driver's phone needs no schedule. The estimate does —
 * and this function used to return null whenever `routeFor` did, so a batch
 * between warehouses the map does not know (a code invented after the route
 * table was written) made the truck vanish entirely, live GPS and all: the
 * phone paired, positions arriving, and nothing on the map. Now the schedule
 * gates only the ESTIMATE; a truck with a position is always drawn.
 *
 * Where it is comes from the ONE assembler (`placeTruck`): the board, the
 * dashboard and the customer's cabinet read the same walk from the same
 * newest evidence, so the dot here and the % there are one answer.
 */
export async function truckFor(
  batch: typeof batches.$inferSelect,
  ends: TruckEnds,
  // The logist's typed border queues (`loadBorderHours`), loaded ONCE by the
  // caller for its whole list — before the optional fix, because it is not
  // optional: the map must not ignore a queue the cabinet counts.
  waits: BorderHours,
  fix?: LatestPosition,
): Promise<TruckMarker | null> {
  const place = placeTruck(
    {
      ...ends,
      departedAt: batch.departedAt,
      checkpoint: batch.trackingCheckpoint,
      fix: placementFix(fix),
    },
    waits,
  );
  const gateDays = gateDaysOf(place, tashkentDay(new Date()));
  // Off the road (below) a truck stands at its destination whether or not a
  // road is modelled; on it, a truck with neither a road nor a phone has no
  // place at all.
  const offRoad = batch.status !== 'in_transit';
  if (!place.route && !fix && !offRoad) return null;

  const contents = await db
    .select({
      clientCode: sql<string | null>`coalesce(${clients.clientCode}, ${receipts.unclaimedMarking})`,
      n: sql<number>`count(distinct ${boxes.id})`,
    })
    .from(boxMovements)
    .innerJoin(boxes, eq(boxMovements.boxId, boxes.id))
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(
      and(
        eq(boxMovements.refType, 'batch'),
        eq(boxMovements.refId, batch.id),
        eq(boxMovements.cause, 'batch_departed'),
        // An annulled box left the trip on paper; the popup must agree.
        ne(boxes.status, 'void'),
      ),
    )
    .groupBy(sql`coalesce(${clients.clientCode}, ${receipts.unclaimedMarking})`);
  const sortedContents = contents
    .map((c) => ({ clientCode: c.clientCode ?? '?', n: Number(c.n) }))
    .sort((a, b) => b.n - a.n);

  const cp = batch.trackingCheckpoint as { key?: string; at?: string } | null;

  // A truck no longer on the road — ARRIVED, its cartons not all scanned off
  // (a Yiwu → Kashgar truck that beat its schedule), or past it — stands at
  // its destination: the walk knows no arrival and must not draw it mid-China
  // with a date the office no longer has, nor follow a driver's phone that is
  // still paired on the drive back (the review; O15). The board and the
  // dashboard say «Yetib keldi» about the same truck. With no destination
  // point known it is listed with none (`placed: false`).
  if (offRoad) {
    const gate = place.route
      ? place.route.points[place.route.points.length - 1]!
      : (WAREHOUSE_POINTS[ends.destCode] ?? null);
    const last = place.route?.segments[place.route.segments.length - 1];
    return {
      batchId: batch.id,
      code: batch.code,
      originCode: ends.originCode,
      destCode: ends.destCode,
      x: gate?.x ?? 0,
      y: gate?.y ?? 0,
      placed: gate !== null,
      atGate: false,
      gateDays: null,
      gateStuck: false,
      live: false,
      fixAgeMinutes: fix?.ageMinutes ?? null,
      fixSource: fix?.source ?? null,
      segKey: last?.key ?? place.segKey ?? 'transit',
      progress: place.route ? 1 : null,
      overdue: false,
      remainingDays: [0, 0],
      dated: false,
      departedAt: (batch.departedAt ?? batch.createdAt).toISOString(),
      checkpointKey: cp?.key ?? null,
      vehiclePlate: batch.vehiclePlate,
      routePoints: place.route?.points ?? [],
      contents: sortedContents,
    };
  }

  if (!place.route) {
    // No road to walk (or no departure stamp) — the phone's own word is all
    // there is, fresh or stale, and it is enough to put the truck on the map.
    const live = fix!;
    return {
      batchId: batch.id,
      code: batch.code,
      originCode: ends.originCode,
      destCode: ends.destCode,
      x: live.lon,
      y: live.lat,
      placed: true,
      // A road nobody modelled still has a yard (`placeTruck`'s no-road gate).
      atGate: place.atGate,
      gateDays,
      gateStuck: stuckAtPhoneGate(gateDays),
      live: live.fresh,
      fixAgeMinutes: live.ageMinutes,
      fixSource: live.source,
      segKey: place.segKey ?? 'transit',
      progress: null,
      overdue: false,
      remainingDays: [0, 0],
      dated: false,
      departedAt: (batch.departedAt ?? batch.createdAt).toISOString(),
      checkpointKey: cp?.key ?? null,
      vehiclePlate: batch.vehiclePlate,
      routePoints: [],
      contents: sortedContents,
    };
  }

  const stage = truckStage(
    stageBatchOf({
      ...ends,
      status: batch.status,
      trackingCheckpoint: batch.trackingCheckpoint,
      customsClearedAt: batch.customsClearedAt,
    }),
  );
  const remaining = place.remainingHours;
  return {
    batchId: batch.id,
    code: batch.code,
    originCode: ends.originCode,
    destCode: ends.destCode,
    // A fresh fix that places the truck is drawn where the phone said (on the
    // road when it is near it — round 100, 9a: «mashina kordinatsiyalari
    // toglar ustiga chiqib ketyabti»; a real detour stays raw). Otherwise
    // the walk's own dot — which a newer pin moves off an older fix.
    x: place.point?.x ?? 0,
    y: place.point?.y ?? 0,
    placed: place.point !== null,
    atGate: place.atGate,
    gateDays,
    gateStuck: stuckAtPhoneGate(gateDays),
    live: place.fresh,
    fixAgeMinutes: fix?.ageMinutes ?? null,
    fixSource: fix?.source ?? null,
    segKey: place.segKey ?? 'transit',
    progress: place.progress,
    overdue: place.overdue,
    remainingDays: remaining
      ? // The upper end rounded UP: a dated truck an hour out is «~0–0.1 kun»,
        // never the «~0–0 kun» `placeDated` exists to keep off every screen.
        [Math.round((remaining[0] / 24) * 10) / 10, Math.ceil((remaining[1] / 24) * 10) / 10]
      : [0, 0],
    // The one rule every reader asks (`placeDated`), on a moving rung (O15).
    dated: placeDated(place) && isMovingStage(stage),
    departedAt: batch.departedAt!.toISOString(),
    checkpointKey: cp?.key ?? null,
    vehiclePlate: batch.vehiclePlate,
    routePoints: place.route.points,
    contents: sortedContents,
  };
}
