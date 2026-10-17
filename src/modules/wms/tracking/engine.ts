/**
 * Transit position estimator (owner's feature: "GPS-like" map). This is a
 * SIMULATION from typical corridor timings, not real telemetry — the UI must
 * always present it as approximate. A manual checkpoint ("still at the
 * border") re-anchors the clock, which is how the operator corrects the
 * inevitable border-wait drift.
 */

export interface RoutePoint {
  x: number;
  y: number;
}

/**
 * A border post whose queue the logist types by hand (owner, 2026-09-29,
 * answer 14: «ochered kamaysa tez otb ketadiku»). The list with its default
 * hours lives in map-data.ts (`BORDER_POSTS`); this is only the name.
 */
export type BorderPost = 'khorgos' | 'yallama';

/**
 * Every leg the route table builds (`map-data.ts`), which is also every
 * `map.seg_*` label. Typed on the table's legs, so a new leg is one place to
 * add and `tracking/place.ts` refuses to compile until the leg has a place.
 */
export const LEG_KEYS = [
  'cn_transit',
  'to_border',
  'border_wait',
  'kz',
  'uz_queue',
  'kg',
  'uz',
  'transit',
] as const;
export type LegKey = (typeof LEG_KEYS)[number];

export interface RouteSegment {
  /** Phase key — also the i18n label key (cn_transit, to_border, border_wait, kz, uz_queue, kg, uz, transit). */
  key: string;
  /** Typical duration range in hours; position uses the midpoint. */
  hours: [number, number];
  /** Point-index span on the route polyline; span[0] === span[1] = stationary (border wait). */
  span: [number, number];
  /**
   * The post whose typed queue replaces `hours` (tracking/eta.ts
   * `routeWithWaits`). Keyed by the POST and never by the shape of the leg:
   * the Kashgar road's `border_wait` is stationary too, and no typed number
   * is about it.
   */
  post?: BorderPost;
}

export interface RouteDef {
  points: RoutePoint[];
  segments: RouteSegment[];
}

export interface TransitEstimate {
  x: number;
  y: number;
  segKey: string;
  /** Where `segKey`'s leg sits in `route.segments`. */
  segIndex: number;
  /**
   * How far through that leg, 0..1 — the share of its hours the schedule has
   * walked, which on a moving leg is also the share of its LENGTH
   * (`pointAlong` spends a leg's length evenly over its hours).
   */
  segFrac: number;
  /**
   * 0..1 of the road's LENGTH behind the dot (owner, 2026-10-17, 4a: «necha
   * foiz yolni bosib otdi» is a distance, not a share of the days). A queue
   * has no length, so a truck waiting at the border keeps its % for the
   * whole wait. A route with no length at all reads its time share.
   */
  progress: number;
  /** True once the schedule says the truck should have arrived. */
  overdue: boolean;
  /** Remaining [min, max] hours by the schedule (0 when overdue). */
  remainingHours: [number, number];
}

/** A segment's hours as the position reads them — exported so eta.ts walks
 *  the schedule with the engine's own arithmetic and never a copy of it. */
export const segMid = (h: readonly [number, number]) => (h[0] + h[1]) / 2;
const mid = segMid;

/**
 * The length of one chord, in degrees, with the east-west axis weighted by
 * cos(lat) — IN RADIANS, which is the half of this formula a slip cannot
 * survive (round 100, 9a). Unweighted, a degree of longitude counted like a
 * degree of latitude, so the pacing along the corridor under-weighted the
 * east-west stretches by ~23 % at 40°N: the dot stayed ON the line but sat
 * the wrong distance along it.
 */
export function chordDeg(a: RoutePoint, b: RoutePoint): number {
  const midLatRad = (((a.y + b.y) / 2) * Math.PI) / 180;
  return Math.hypot((b.x - a.x) * Math.cos(midLatRad), b.y - a.y);
}

/**
 * The road's length from its first point to each of its points, in
 * `chordDeg` units — the one measure the dot is paced by, so the % and the
 * dot cannot disagree about how far along it is.
 */
export function cumulativeLengths(points: RoutePoint[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < points.length; i += 1) out.push(out[i - 1]! + chordDeg(points[i - 1]!, points[i]!));
  return out;
}

function pointAlong(points: RoutePoint[], from: number, to: number, frac: number): RoutePoint {
  if (to <= from) return points[from]!;
  const seg = points.slice(from, to + 1);
  const dists: number[] = [];
  let total = 0;
  for (let i = 0; i < seg.length - 1; i += 1) {
    const d = chordDeg(seg[i]!, seg[i + 1]!);
    dists.push(d);
    total += d;
  }
  if (total === 0) return seg[0]!;
  let target = frac * total;
  for (let i = 0; i < dists.length; i += 1) {
    if (target <= dists[i]! || i === dists.length - 1) {
      const t = dists[i]! === 0 ? 0 : Math.min(1, target / dists[i]!);
      return {
        x: seg[i]!.x + (seg[i + 1]!.x - seg[i]!.x) * t,
        y: seg[i]!.y + (seg[i + 1]!.y - seg[i]!.y) * t,
      };
    }
    target -= dists[i]!;
  }
  return seg[seg.length - 1]!;
}

/**
 * Where is the truck now? `elapsedHours` counts from departure — or, when a
 * checkpoint anchor is set, from the START of the anchored segment.
 */
export function estimateTransit(
  route: RouteDef,
  elapsedHours: number,
  // `segIndex` names the leg by position when the caller knows it (a fix
  // laid on the road, eta.ts); the key alone is the pin's older form.
  anchor?: { segKey: string; elapsedInSegHours: number; segIndex?: number } | null,
): TransitEstimate {
  const totalMid = route.segments.reduce((a, s) => a + mid(s.hours), 0);
  const cum = cumulativeLengths(route.points);
  const totalLen = cum[cum.length - 1] ?? 0;
  let startIdx = 0;
  let remaining = Math.max(0, elapsedHours);
  if (anchor) {
    const idx =
      anchor.segIndex !== undefined && route.segments[anchor.segIndex]?.key === anchor.segKey
        ? anchor.segIndex
        : route.segments.findIndex((s) => s.key === anchor.segKey);
    if (idx >= 0) {
      startIdx = idx;
      remaining = Math.max(0, anchor.elapsedInSegHours);
    }
  }
  let doneMid = route.segments.slice(0, startIdx).reduce((a, s) => a + mid(s.hours), 0);

  for (let i = startIdx; i < route.segments.length; i += 1) {
    const seg = route.segments[i]!;
    const m = mid(seg.hours);
    if (remaining < m || i === route.segments.length - 1) {
      const frac = Math.min(1, m === 0 ? 1 : remaining / m);
      const pos = pointAlong(route.points, seg.span[0], seg.span[1], frac);
      const later = route.segments.slice(i + 1);
      const remainMin = Math.max(0, seg.hours[0] * (1 - frac)) + later.reduce((a, s) => a + s.hours[0], 0);
      const remainMax = Math.max(0, seg.hours[1] * (1 - frac)) + later.reduce((a, s) => a + s.hours[1], 0);
      const overdue = i === route.segments.length - 1 && remaining >= m;
      // The length behind the dot: the legs before it whole, this one by the
      // same fraction `pointAlong` drew it at.
      const along = cum[seg.span[0]]! + frac * (cum[seg.span[1]]! - cum[seg.span[0]]!);
      return {
        x: pos.x,
        y: pos.y,
        segKey: seg.key,
        segIndex: i,
        segFrac: frac,
        progress:
          totalLen > 0
            ? Math.min(1, along / totalLen)
            : Math.min(1, (doneMid + Math.min(remaining, m)) / totalMid),
        overdue,
        remainingHours: overdue ? [0, 0] : [Math.round(remainMin), Math.round(remainMax)],
      };
    }
    remaining -= m;
    doneMid += m;
  }
  // Unreachable (last segment handled above), but keep TS satisfied.
  const last = route.points[route.points.length - 1]!;
  return {
    x: last.x,
    y: last.y,
    segKey: 'transit',
    segIndex: route.segments.length - 1,
    segFrac: 1,
    progress: 1,
    overdue: true,
    remainingHours: [0, 0],
  };
}

/**
 * A fix older than this is stale: the map stops drawing the dot AT it and the
 * source line says how old it is (`placeTruck` still anchors the walk on it).
 *
 * The driver app reports every 2-3 hours by design — the owner asked for a
 * schedule the driver's battery survives, not a live dot. So "fresh" has to
 * cover a missed cycle plus a dead zone; anything tighter would paint every
 * real fix as stale and hand the map back to the estimate. Pure here (it
 * moved out of devices.ts, which re-exports it) because the one assembler
 * that judges it, eta.ts, must not import the database.
 */
export const FRESH_MINUTES = 8 * 60;

/**
 * A fix, laid on the road: the nearest point ON it, which chord holds that
 * point, how much of the road lies behind it, and how far the fix itself is
 * from the line. One projection for the map's dot (`snapToRoute`) and the
 * place a fix gives a truck (eta.ts `placeTruck`), so the dot and the % are
 * the same point. The parameter along each chord is plain lon/lat (the
 * drawing's space); the distances are `chordDeg`.
 */
export interface RouteProjection {
  point: RoutePoint;
  /** The chord `[chord, chord + 1]` the point lies on. */
  chord: number;
  /** The road's length from its start to `point` (`chordDeg` units). */
  along: number;
  /** How far the fix is from `point` (`chordDeg`). */
  offDeg: number;
}

export function projectOnRoute(points: RoutePoint[], fix: RoutePoint): RouteProjection | null {
  if (points.length < 2) return null;
  const cum = cumulativeLengths(points);
  let best: RouteProjection | null = null;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t =
      lenSq === 0
        ? 0
        : Math.max(0, Math.min(1, ((fix.x - a.x) * dx + (fix.y - a.y) * dy) / lenSq));
    const candidate = { x: a.x + dx * t, y: a.y + dy * t };
    const offDeg = chordDeg(candidate, fix);
    // Strictly nearer: at a vertex two legs share, the earlier leg keeps it.
    if (!best || offDeg < best.offDeg) {
      best = { point: candidate, chord: i, along: cum[i]! + t * (cum[i + 1]! - cum[i]!), offDeg };
    }
  }
  return best;
}

/**
 * The nearest point ON the route to a GPS fix — or null when the fix is
 * genuinely off the corridor (round 100, 9a).
 *
 * A phone's fix lands tens of metres off the drawn line as a matter of
 * course, and painted raw it puts the lorry on a mountainside beside the
 * road the polyline draws. Within `tolDeg` the truth is «on this road, here»
 * and the marker snaps; beyond it the raw fix wins, because a real detour is
 * information the map must not iron flat. The tolerance is degrees for the
 * same reason the whole engine is: this is a drawing, not surveying.
 */
export function snapToRoute(
  points: RoutePoint[],
  fix: RoutePoint,
  tolDeg = 0.15,
): RoutePoint | null {
  const p = projectOnRoute(points, fix);
  return p !== null && p.offDeg <= tolDeg ? p.point : null;
}
