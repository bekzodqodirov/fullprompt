/**
 * Where a factory-pickup truck is, by estimate (owner, 2026-09-24, D1:
 * «taxminiy boradigan vaqti hisoblanib, taxminiy navigatsiyaga o'xshab
 * taxminiy yursin mashina mapda»). A SIMULATION, like the corridor engine
 * beside it: nothing on the truck reports a position, so the screen must
 * always say «taxminiy».
 *
 * The route is factory 1 → factory 2 → … → our warehouse, each hop a stored
 * leg (the road fetched once when the trip was saved, or a straight line).
 * The clock:
 *  - before the first «olindi» press the truck is standing at factory 1;
 *  - a stop's «olindi» press is the moment it LEAVES that factory — the
 *    logist presses it when the driver confirms the load;
 *  - the timeline is anchored on the LATEST press, whichever stop it is on
 *    (B3: the driver takes factory 2 first when that is where the road goes).
 *    Everything before it is history, drawn as road travelled; an
 *    uncollected stop before it is one the driver skipped or has not
 *    reported, and the lorry is never sent BACK to it;
 *  - from the anchor it drives each leg in its stored hours and stands
 *    DWELL_HOURS at every factory still to be loaded (none at one already
 *    pressed out of order);
 *  - after the last leg it is at the warehouse, «overdue» if nobody has
 *    received it yet.
 *
 * Pure and dependency-free: the page computes the first position on the
 * server and the browser recomputes it every few seconds from the same
 * timeline, so the lorry GLIDES instead of jumping once a minute.
 */

export type LngLat = [number, number];

/** How long a truck stands at a factory being loaded, by assumption. */
export const DWELL_HOURS = 2;

export interface PickupLegInput {
  /** Road points from this stop to the next stop (or the warehouse), both ends exact. */
  points: LngLat[];
  hours: number;
}

export interface PickupStopInput {
  point: LngLat;
  /** The «olindi» press: when the truck left this factory. */
  collectedAt: Date | null;
  /** The road on from here; null when the stop has no coordinates yet. */
  leg: PickupLegInput | null;
}

/** One hop of the timeline, instants in ms since epoch (JSON-safe for the browser). */
export interface TimelineHop {
  points: LngLat[];
  departAt: number;
  arriveAt: number;
  /** True when the departure is a person's press, not the schedule's guess. */
  departConfirmed: boolean;
}

export interface PickupTimeline {
  /** Where the truck stands now-or-next: the anchor stop, or factory 1 before any press. */
  start: LngLat;
  hops: TimelineHop[];
  /** Null until the first press — the schedule has no anchor before it. */
  startedAt: number | null;
  /** Road already behind the truck (legs of stops before the anchor that it drove). */
  done: LngLat[][];
}

export type PickupPhase = 'waiting' | 'driving' | 'loading' | 'arrived';

export interface PickupPosition {
  point: LngLat;
  phase: PickupPhase;
  /** Index of the hop being driven, or the hop just finished (loading/arrived). */
  hopIndex: number;
  /** 0..1 along the whole route by time; 0 while waiting. */
  progress: number;
  /** The estimated arrival at the warehouse, or null before the first press. */
  etaAt: number | null;
  /** The schedule says it should be there and nobody has received it. */
  overdue: boolean;
}

const HOUR = 3_600_000;

/**
 * Build the timeline. A stop with no leg (no coordinates on it or the next
 * stop yet) ends the route there — the truck can still be drawn as far as
 * the map knows, never somewhere invented.
 */
export function pickupTimeline(stops: PickupStopInput[]): PickupTimeline | null {
  if (stops.length === 0) return null;
  let anchor = -1;
  for (let i = 0; i < stops.length; i += 1) {
    const at = stops[i]!.collectedAt?.getTime();
    if (at === undefined) continue;
    if (anchor < 0 || at >= stops[anchor]!.collectedAt!.getTime()) anchor = i;
  }
  if (anchor < 0) return { start: stops[0]!.point, hops: [], startedAt: null, done: [] };

  // Behind the truck: the legs it drove to reach the anchor, i.e. the legs of
  // COLLECTED stops before it. A skipped factory's leg is not road it drove.
  const done: LngLat[][] = [];
  for (let i = 0; i < anchor; i += 1) {
    const stop = stops[i]!;
    if (stop.collectedAt && stop.leg && stop.leg.points.length >= 2) done.push(stop.leg.points);
  }

  const hops: TimelineHop[] = [];
  const startedAt = stops[anchor]!.collectedAt!.getTime();
  let clock = startedAt;
  for (let i = anchor; i < stops.length; i += 1) {
    const stop = stops[i]!;
    if (!stop.leg || stop.leg.points.length < 2) break;
    // The anchor leaves at its press; a later stop already pressed (out of
    // order, earlier than the anchor) is passed through without loading; any
    // other stop is loaded for DWELL_HOURS after the truck gets there.
    const departAt =
      i === anchor ? startedAt : stop.collectedAt ? clock : clock + DWELL_HOURS * HOUR;
    // Hours are never zero: two factories geocoded to one point would divide
    // progress by nothing and print NaN on the bar.
    const hours = Math.max(stop.leg.hours, 0.25);
    const arriveAt = departAt + hours * HOUR;
    hops.push({ points: stop.leg.points, departAt, arriveAt, departConfirmed: i === anchor });
    clock = arriveAt;
  }
  return { start: stops[anchor]!.point, hops, startedAt, done };
}

function chord(a: LngLat, b: LngLat): number {
  const midLatRad = (((a[1] + b[1]) / 2) * Math.PI) / 180;
  return Math.hypot((b[0] - a[0]) * Math.cos(midLatRad), b[1] - a[1]);
}

/** The point `frac` of the way along a polyline, by distance. */
export function alongPolyline(points: LngLat[], frac: number): LngLat {
  if (points.length === 1 || frac <= 0) return points[0]!;
  if (frac >= 1) return points[points.length - 1]!;
  const lengths = points.slice(1).map((p, i) => chord(points[i]!, p));
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total === 0) return points[0]!;
  let left = frac * total;
  for (let i = 0; i < lengths.length; i += 1) {
    const len = lengths[i]!;
    if (left <= len) {
      const t = len === 0 ? 0 : left / len;
      const a = points[i]!;
      const b = points[i + 1]!;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    left -= len;
  }
  return points[points.length - 1]!;
}

/** Where the truck is at `now` (ms), by the timeline. */
export function pickupPosition(timeline: PickupTimeline, now: number): PickupPosition {
  const { hops } = timeline;
  const last = hops[hops.length - 1];
  const etaAt = last ? last.arriveAt : null;
  if (!hops.length || now < hops[0]!.departAt) {
    return { point: timeline.start, phase: 'waiting', hopIndex: 0, progress: 0, etaAt, overdue: false };
  }
  const begin = hops[0]!.departAt;
  const span = Math.max(etaAt! - begin, 1);
  const progress = Math.min(1, Math.max(0, (now - begin) / span));
  for (let i = 0; i < hops.length; i += 1) {
    const hop = hops[i]!;
    if (now < hop.departAt) {
      // Standing at the factory this hop leaves from, being loaded.
      return { point: hop.points[0]!, phase: 'loading', hopIndex: i - 1, progress, etaAt, overdue: false };
    }
    if (now < hop.arriveAt) {
      const frac = (now - hop.departAt) / (hop.arriveAt - hop.departAt);
      return { point: alongPolyline(hop.points, frac), phase: 'driving', hopIndex: i, progress, etaAt, overdue: false };
    }
  }
  return {
    point: last!.points[last!.points.length - 1]!,
    phase: 'arrived',
    hopIndex: hops.length - 1,
    progress: 1,
    etaAt,
    overdue: true,
  };
}
