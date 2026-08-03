import { describe, expect, it } from 'vitest';
import { estimateTransit, type RouteDef, type RoutePoint } from '@/modules/wms/tracking/engine';
import { routeFor } from '@/modules/wms/tracking/map-data';

/**
 * The corridor has to be the ROAD (round 47, owner's item 10: «to'g'ri liniya
 * boyicha emas marshurud boyicha yoldan yursin»).
 *
 * Two different things are checked here, and both used to be maintained by
 * hand. The first is that the estimator can walk the route at all: segment
 * spans are point INDICES, they were written as literals, and one wrong number
 * parks a truck on the wrong side of a border with nothing on screen to say
 * so. `build` computes them now, so the invariant is worth pinning.
 *
 * The second is the owner's actual complaint. A truck between Urumqi and Aksu
 * does not fly over the Tian Shan; it goes south through Toksun and Korla and
 * then west. With the old two-point route the estimate sat about 1.5° — some
 * 130 km — from Korla at its closest, in the middle of a mountain range.
 */

const PAIRS: [string, string][] = [
  ['YW', 'KA'],
  ['GZ', 'KA'],
  ['UCH', 'KA'],
  ['KA', 'AND'],
  ['KA', 'TAS1'],
  ['KA', 'TAS2'],
  ['AND', 'TAS1'],
  ['YW', 'TAS1'], // no corridor defined: the honest straight line
];

/** Closest approach of a sampled path to a point, in degrees. */
function nearest(path: RoutePoint[], target: RoutePoint): number {
  return Math.min(...path.map((p) => Math.hypot(p.x - target.x, p.y - target.y)));
}

/** Walk the whole schedule and collect where the truck is said to be. */
function walk(route: RouteDef): RoutePoint[] {
  const total = route.segments.reduce((a, s) => a + (s.hours[0] + s.hours[1]) / 2, 0);
  const path: RoutePoint[] = [];
  for (let step = 0; step <= 200; step += 1) {
    const at = estimateTransit(route, (total * step) / 200);
    path.push({ x: at.x, y: at.y });
  }
  return path;
}

describe('the corridor a truck is drawn on', () => {
  it('gives every segment a span that exists and joins the next one', () => {
    for (const [origin, dest] of PAIRS) {
      const route = routeFor(origin, dest);
      expect(route, `${origin}→${dest}`).not.toBeNull();
      const { points, segments } = route!;
      expect(segments.length, `${origin}→${dest}`).toBeGreaterThan(0);
      let previousEnd: number | null = null;
      for (const seg of segments) {
        const where = `${origin}→${dest} ${seg.key}`;
        expect(seg.span[0], where).toBeGreaterThanOrEqual(0);
        expect(seg.span[1], where).toBeLessThan(points.length);
        expect(seg.span[1], where).toBeGreaterThanOrEqual(seg.span[0]);
        if (previousEnd !== null) expect(seg.span[0], where).toBe(previousEnd);
        previousEnd = seg.span[1];
      }
      // The last segment has to land ON the destination, or a truck that has
      // arrived is drawn short of the warehouse for ever.
      expect(previousEnd, `${origin}→${dest}`).toBe(points.length - 1);
    }
  });

  it('keeps the border wait stationary, at the border', () => {
    const route = routeFor('KA', 'TAS1')!;
    const wait = route.segments.find((s) => s.key === 'border_wait')!;
    expect(wait.span[0]).toBe(wait.span[1]);
    const at = route.points[wait.span[0]]!;
    // Irkeshtam.
    expect(Math.hypot(at.x - 73.91, at.y - 39.68)).toBeLessThan(0.01);
  });

  it('goes around the Tian Shan through Korla, not over it', () => {
    const path = walk(routeFor('UCH', 'KA')!);
    // Korla. A straight Urumqi→Aksu line misses it by ~1.5°.
    expect(nearest(path, { x: 86.15, y: 41.73 })).toBeLessThan(0.4);
  });

  it('takes the Kamchik pass road home, through Kokand and Angren', () => {
    const path = walk(routeFor('AND', 'TAS1')!);
    expect(nearest(path, { x: 70.94, y: 40.53 })).toBeLessThan(0.4); // Kokand
    expect(nearest(path, { x: 70.14, y: 41.02 })).toBeLessThan(0.4); // Angren
  });

  it('runs the Hexi corridor between Lanzhou and Hami', () => {
    const path = walk(routeFor('YW', 'KA')!);
    expect(nearest(path, { x: 100.45, y: 38.93 })).toBeLessThan(0.4); // Zhangye
    expect(nearest(path, { x: 95.78, y: 40.52 })).toBeLessThan(0.4); // Guazhou
  });

  it('never leaves the drawn line — the estimate IS a point on the road', () => {
    for (const [origin, dest] of PAIRS) {
      const route = routeFor(origin, dest)!;
      for (const at of walk(route)) {
        // Distance to the nearest SEGMENT of the polyline, not to its corners.
        let best = Infinity;
        for (let i = 0; i < route.points.length - 1; i += 1) {
          const a = route.points[i]!;
          const b = route.points[i + 1]!;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len2 = dx * dx + dy * dy;
          const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / len2));
          best = Math.min(best, Math.hypot(at.x - (a.x + dx * t), at.y - (a.y + dy * t)));
        }
        expect(best, `${origin}→${dest}`).toBeLessThan(0.001);
      }
    }
  });
});
