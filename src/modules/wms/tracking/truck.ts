import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, boxes, boxMovements, clients, receiptLots, receipts } from '../../platform/db/schema';
import { scheduleEstimate } from './eta';
import { snapToRoute } from './engine';
import type { LatestPosition } from './devices';

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
  live: boolean;
  fixAgeMinutes: number | null;
  fixSource: string | null;
  segKey: string;
  progress: number;
  overdue: boolean;
  remainingDays: [number, number];
  departedAt: string;
  checkpointKey: string | null;
  vehiclePlate: string | null;
  routePoints: { x: number; y: number }[];
  contents: { clientCode: string; n: number }[];
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
 */
export async function truckFor(
  batch: typeof batches.$inferSelect,
  originCode: string,
  destCode: string,
  fix?: LatestPosition,
): Promise<TruckMarker | null> {
  // One assembler for the whole app (`tracking/eta.ts`): the customer's
  // cabinet reads the same schedule through the same anchoring, so the truck
  // on the map and the date in the client's phone cannot disagree.
  const schedule = scheduleEstimate(originCode, destCode, batch.departedAt, batch.trackingCheckpoint);
  if (!schedule && !fix) return null;

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
      ),
    )
    .groupBy(sql`coalesce(${clients.clientCode}, ${receipts.unclaimedMarking})`);
  const sortedContents = contents
    .map((c) => ({ clientCode: c.clientCode ?? '?', n: Number(c.n) }))
    .sort((a, b) => b.n - a.n);

  const cp = batch.trackingCheckpoint as { key?: string; at?: string } | null;

  if (!schedule) {
    // No route (or no departure stamp) — the phone's own word is all there
    // is, fresh or stale, and it is enough to put the truck on the map.
    const live = fix!;
    return {
      batchId: batch.id,
      code: batch.code,
      originCode,
      destCode,
      x: live.lon,
      y: live.lat,
      live: live.fresh,
      fixAgeMinutes: live.ageMinutes,
      fixSource: live.source,
      segKey: 'transit',
      progress: 0,
      overdue: false,
      remainingDays: [0, 0],
      departedAt: (batch.departedAt ?? batch.createdAt).toISOString(),
      checkpointKey: cp?.key ?? null,
      vehiclePlate: batch.vehiclePlate,
      routePoints: [],
      contents: sortedContents,
    };
  }

  const { route, est } = schedule;

  // A fresh fix from the driver's phone replaces the estimated dot; a stale
  // one is kept as information but the schedule drives the marker again.
  const live = fix?.fresh ? fix : null;
  // A fix near the corridor is drawn ON it (round 100, 9a — the owner:
  // «mashina kordinatsiyalari toglar ustiga chiqib ketyabti»): a phone's
  // fix is honestly tens of metres off the drawn line, and painted raw it
  // parks the lorry on the mountainside beside the road. A fix genuinely OFF
  // the corridor stays raw — a detour is information, not noise.
  const snapped = live ? snapToRoute(route.points, { x: live.lon, y: live.lat }) : null;

  return {
    batchId: batch.id,
    code: batch.code,
    originCode,
    destCode,
    x: live ? (snapped?.x ?? live.lon) : est.x,
    y: live ? (snapped?.y ?? live.lat) : est.y,
    live: live !== null,
    fixAgeMinutes: fix?.ageMinutes ?? null,
    fixSource: fix?.source ?? null,
    segKey: est.segKey,
    progress: est.progress,
    overdue: est.overdue,
    remainingDays: [
      Math.round((est.remainingHours[0] / 24) * 10) / 10,
      Math.round((est.remainingHours[1] / 24) * 10) / 10,
    ],
    departedAt: batch.departedAt!.toISOString(),
    checkpointKey: cp?.key ?? null,
    vehiclePlate: batch.vehiclePlate,
    routePoints: route.points,
    contents: sortedContents,
  };
}
