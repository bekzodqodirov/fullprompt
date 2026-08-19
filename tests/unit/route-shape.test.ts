import { describe, expect, it } from 'vitest';
import { estimateTransit, type RouteDef, type RoutePoint } from '@/modules/wms/tracking/engine';
import { routeFor } from '@/modules/wms/tracking/map-data';
import { ROAD_LEG_POINTS } from '@/modules/wms/tracking/road-geometry';

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

  it('turns before Kashgar at Artux (round 100)', () => {
    // 0.1, not the 0.4 the older pins use: the straight BCH→KA chord passes
    // 0.225° from Artux, so a loose pin would stay green with the bend
    // removed — a red proof that will not go red is evidence about the
    // fixture (#166). (Tianzhu, added in the same round, gets NO pin: it
    // sits 0.055° from the old chord — it paces the Wushaoling climb, it
    // does not bend the drawing, and no honest threshold can see it.)
    const path = walk(routeFor('YW', 'KA')!);
    expect(nearest(path, { x: 76.17, y: 39.72 })).toBeLessThan(0.1); // Artux
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

/**
 * The stored road geometry (round 109) is fetched by a script with the
 * corridor's endpoints typed by hand — and the FIRST run typed Irkeshtam
 * 0.95° east of the border post, so Kashgar→border stopped 80 km short and
 * the Kyrgyz leg began inside China. Nothing on any screen would have said
 * so: the line still drew, the wait still waited, the ETA still counted.
 * This is the fence: every stored leg must begin and end on the point the
 * app itself calls that place.
 */
describe('the stored road geometry ends where the app says the place is', () => {
  const NEAR = 0.15; // ~15 km — a road snaps to the highway, not to our dot.
  const P = {
    YW: { x: 120.07, y: 29.31 },
    GZ: { x: 113.26, y: 23.13 },
    KA: { x: 75.98, y: 39.47 },
    UCH: { x: 87.62, y: 43.83 },
    IRK: { x: 73.91, y: 39.68 },
    OSH: { x: 72.8, y: 40.53 },
    AND: { x: 72.34, y: 40.78 },
    TAS: { x: 69.24, y: 41.31 },
  };
  const ENDS: Record<string, [keyof typeof P, keyof typeof P]> = {
    yw_ka: ['YW', 'KA'],
    gz_ka: ['GZ', 'KA'],
    uch_ka: ['UCH', 'KA'],
    ka_irk: ['KA', 'IRK'],
    irk_osh: ['IRK', 'OSH'],
    osh_and: ['OSH', 'AND'],
    and_tas: ['AND', 'TAS'],
    osh_tas: ['OSH', 'TAS'],
  };

  it('every leg starts and ends on its named place', () => {
    for (const [key, [from, to]] of Object.entries(ENDS)) {
      const pts = ROAD_LEG_POINTS[key];
      expect(pts, key).toBeDefined();
      const first = pts![0]!;
      const last = pts![pts!.length - 1]!;
      expect(Math.hypot(first[0] - P[from].x, first[1] - P[from].y), `${key} start`).toBeLessThan(NEAR);
      expect(Math.hypot(last[0] - P[to].x, last[1] - P[to].y), `${key} end`).toBeLessThan(NEAR);
    }
  });

  it('a through truck drives the same road as the two-leg journey', () => {
    // Round 109: one batch booked Yiwu → Tashkent is drawn as the China road
    // plus the Kashgar–Tashkent road, not as a straight line across the
    // Taklamakan. Composed, never re-typed — so the two can never disagree.
    const through = routeFor('YW', 'TAS1')!;
    const cn = routeFor('YW', 'KA')!;
    const uz = routeFor('KA', 'TAS1')!;
    // The seam is deduped by `build`, so the whole is one point shorter than
    // the sum — and that missing point is the shared Kashgar node.
    expect(through.points.length).toBe(cn.points.length + uz.points.length - 1);
    expect(through.points[0]).toEqual(cn.points[0]);
    expect(through.points[through.points.length - 1]).toEqual(uz.points[uz.points.length - 1]);
    // Every kilometre of the Chinese half is the Chinese half.
    expect(through.points.slice(0, cn.points.length)).toEqual(cn.points);
  });

  it('the China corridor never climbs to Urumqi', () => {
    // The owner's correction (round 109): the road turns south-west at
    // Toksun; Urumqi is 43.83°N and a ~300 km detour the truck does not make.
    for (const key of ['yw_ka', 'gz_ka']) {
      const top = Math.max(...ROAD_LEG_POINTS[key]!.map((p) => p[1]));
      expect(top, key).toBeLessThan(43.5);
    }
  });
});
