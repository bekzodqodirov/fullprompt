import { describe, expect, it } from 'vitest';
import { chordDeg, snapToRoute } from '@/modules/wms/tracking/engine';
import { routeFor } from '@/modules/wms/tracking/map-data';

/**
 * Round 100 (9a): the truck follows the road.
 *
 * Two halves. `chordDeg` paces the dot ALONG the polyline with the east-west
 * axis weighted by cos(lat) — in RADIANS, which is the half of the formula a
 * slip cannot survive, so the weight itself is asserted. `snapToRoute` puts a
 * GPS fix ON the drawn line when it is near it, and leaves a genuine detour
 * alone.
 */
describe('chordDeg', () => {
  it('a pure east-west degree at 40°N costs cos(40°) of a north-south one', () => {
    const ew = chordDeg({ x: 80, y: 40 }, { x: 81, y: 40 });
    const ns = chordDeg({ x: 80, y: 39.5 }, { x: 80, y: 40.5 });
    // cos(40°) ≈ 0.766. A degrees-for-radians slip gives cos(40 rad) ≈ -0.667
    // — negative, so the assertion cannot pass by accident.
    expect(ew / ns).toBeCloseTo(Math.cos((40 * Math.PI) / 180), 3);
    expect(ew / ns).toBeGreaterThan(0);
  });
});

describe('snapToRoute', () => {
  const route = routeFor('YW', 'KA')!;

  it('a fix beside the road lands ON the drawn line', () => {
    // Take a real mid-chord point and nudge it 0.05° north — a typical GPS
    // offset at this drawing's scale.
    const a = route.points[10]!;
    const b = route.points[11]!;
    const onRoad = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const fix = { x: onRoad.x, y: onRoad.y + 0.05 };
    const snapped = snapToRoute(route.points, fix);
    expect(snapped).not.toBeNull();
    // The snap can never move the dot FARTHER than the fix's own offset —
    // `onRoad` is on the polyline, so the nearest point is at most 0.05 away.
    // (Not asserted against `onRoad` itself: on a bending route the nearest
    // segment may be a neighbouring chord, and that is correct behaviour.)
    expect(chordDeg(snapped!, fix)).toBeLessThanOrEqual(0.0501);
  });

  it('a genuine detour is kept raw — far from the corridor means null', () => {
    expect(snapToRoute(route.points, { x: 100, y: 30 })).toBeNull();
  });

  it('tolerance is the fence: just inside snaps, just outside does not', () => {
    const a = route.points[5]!;
    const near = { x: a.x, y: a.y + 0.1 };
    const far = { x: a.x, y: a.y + 0.3 };
    expect(snapToRoute(route.points, near)).not.toBeNull();
    expect(snapToRoute(route.points, far)).toBeNull();
  });
});
