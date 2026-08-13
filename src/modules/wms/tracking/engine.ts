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

export interface RouteSegment {
  /** Phase key — also the i18n label key (cn_transit, to_border, border_wait, kg, uz, transit). */
  key: string;
  /** Typical duration range in hours; position uses the midpoint. */
  hours: [number, number];
  /** Point-index span on the route polyline; span[0] === span[1] = stationary (border wait). */
  span: [number, number];
}

export interface RouteDef {
  points: RoutePoint[];
  segments: RouteSegment[];
}

export interface TransitEstimate {
  x: number;
  y: number;
  segKey: string;
  /** 0..1 across the whole route (time-based). */
  progress: number;
  /** True once the schedule says the truck should have arrived. */
  overdue: boolean;
  /** Remaining [min, max] hours by the schedule (0 when overdue). */
  remainingHours: [number, number];
}

const mid = (h: [number, number]) => (h[0] + h[1]) / 2;

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
  anchor?: { segKey: string; elapsedInSegHours: number } | null,
): TransitEstimate {
  const totalMid = route.segments.reduce((a, s) => a + mid(s.hours), 0);
  let startIdx = 0;
  let remaining = Math.max(0, elapsedHours);
  if (anchor) {
    const idx = route.segments.findIndex((s) => s.key === anchor.segKey);
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
      return {
        x: pos.x,
        y: pos.y,
        segKey: seg.key,
        progress: Math.min(1, (doneMid + Math.min(remaining, m)) / totalMid),
        overdue,
        remainingHours: overdue ? [0, 0] : [Math.round(remainMin), Math.round(remainMax)],
      };
    }
    remaining -= m;
    doneMid += m;
  }
  // Unreachable (last segment handled above), but keep TS satisfied.
  const last = route.points[route.points.length - 1]!;
  return { x: last.x, y: last.y, segKey: 'transit', progress: 1, overdue: true, remainingHours: [0, 0] };
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
  let best: RoutePoint | null = null;
  let bestDist = Infinity;
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
    const dist = chordDeg(candidate, fix);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best !== null && bestDist <= tolDeg ? best : null;
}
