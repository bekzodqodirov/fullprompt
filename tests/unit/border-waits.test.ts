import { describe, expect, it } from 'vitest';
import { estimateTransit, segMid } from '@/modules/wms/tracking/engine';
import { routeWithWaits, scheduleEstimate, type BorderHours } from '@/modules/wms/tracking/eta';
import { BORDER_POSTS, routeFor } from '@/modules/wms/tracking/map-data';

/**
 * The logist's typed border queues (owner, 2026-09-29, answer 14: «ochered
 * kamaysa tez otb ketadiku»), walked into the schedule by `routeWithWaits`.
 *
 * What the typed number MEANS is the panel's printed sentence: how long a
 * truck arriving at the queue NOW waits; trucks already queueing are counted
 * from this moment too; trucks that have crossed are unchanged. Each case
 * below is one clause of that sentence, and the oracle is the engine's own
 * arithmetic on the owner's default hours (`BORDER_POSTS`), never a number
 * this file restates about a route (#166).
 */

const HOUR = 3_600_000;
const NOW = new Date('2026-09-29T06:00:00.000Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);
const at = (hours: number) => ago(-hours).getTime();

const HOR = routeFor('HOR', 'TAS1')!;
const seg = (route = HOR, key: string) => route.segments.find((s) => s.key === key)!;
/** Σ of the later legs' [min, max] — the part of «remaining» a queue does not touch. */
const after = (route: typeof HOR, key: string) => {
  const i = route.segments.findIndex((s) => s.key === key);
  return route.segments
    .slice(i + 1)
    .reduce<[number, number]>((acc, s) => [acc[0] + s.hours[0], acc[1] + s.hours[1]], [0, 0]);
};

describe('routeWithWaits — the typed queue in place of the default wait', () => {
  it('(a) a truck not yet at the post waits exactly the typed range', () => {
    // Departed now, the number typed now: it reaches the post in ~2 h.
    const waits: BorderHours = { khorgos: { hours: [24, 48], sinceMs: at(0) } };
    const route = routeWithWaits(HOR, { segIdx: 0, atMs: at(0) }, waits);
    expect(seg(route, 'border_wait').hours).toEqual([24, 48]);
    // Nothing else moved, and the input was not mutated.
    expect(seg(HOR, 'border_wait').hours).toEqual([...BORDER_POSTS.khorgos]);
    expect(seg(route, 'kz').hours).toEqual(seg(HOR, 'kz').hours);
  });

  it('(b) a truck the defaults had already moved past keeps the defaults', () => {
    // Departed 80 h ago: to the post ~2 h, default wait ~72 h — across at
    // ~74 h, i.e. six hours before a number typed NOW. A queue changing today
    // does not move a truck that crossed this morning back to the border.
    const departed = ago(80);
    const typedLater: BorderHours = { khorgos: { hours: [72, 96], sinceMs: NOW.getTime() } };
    const s = scheduleEstimate('HOR', 'TAS1', departed, null, typedLater, NOW)!;
    expect(s.est.segKey).toBe('kz');
    expect(seg(s.route, 'border_wait').hours).toEqual([...BORDER_POSTS.khorgos]);
  });

  it('(c) a truck pinned at the post 48 h ago, «12–24» typed now: 12–24 h of queue left', () => {
    const waits: BorderHours = { khorgos: { hours: [12, 24], sinceMs: NOW.getTime() } };
    const s = scheduleEstimate('HOR', 'TAS1', ago(60), { key: 'at_border', at: ago(48).toISOString() }, waits, NOW)!;
    // Still in the queue — it did not teleport across because 48 > 24.
    expect(s.est.segKey).toBe('border_wait');
    const later = after(s.route, 'border_wait');
    expect(s.est.remainingHours).toEqual([12 + later[0], 24 + later[1]]);
  });

  it('(d) a number RAISED while the truck waits: the typed range is what is left', () => {
    const waits: BorderHours = { khorgos: { hours: [96, 120], sinceMs: NOW.getTime() } };
    const s = scheduleEstimate('HOR', 'TAS1', ago(20), { key: 'at_border', at: ago(10).toISOString() }, waits, NOW)!;
    expect(s.est.segKey).toBe('border_wait');
    const later = after(s.route, 'border_wait');
    expect(s.est.remainingHours).toEqual([96 + later[0], 120 + later[1]]);
  });

  it('(e) the Yallama queue is entered on the ADJUSTED Khorgos midpoint', () => {
    // Khorgos typed [12, 24] 10 h after departure: the truck reached the post
    // at ~2 h, had queued 8 h, so it leaves at 2 + 8 + 18 = 28 h and reaches
    // Yallama after the ~24 h Kazakh road, at ~52 h. With the DEFAULT Khorgos
    // wait it would reach Yallama at ~98 h.
    const departed = at(0);
    const toBorder = segMid(seg(HOR, 'to_border').hours);
    const kz = segMid(seg(HOR, 'kz').hours);
    const entersYallama = toBorder + 8 + 18 + kz;
    // Yallama typed 8 h after the truck (by the adjusted clock) got there:
    // it is queueing, so its lead is 8 h — by the default clock it would not
    // have arrived yet and its lead would be 0.
    const waits: BorderHours = {
      khorgos: { hours: [12, 24], sinceMs: departed + (toBorder + 8) * HOUR },
      yallama: { hours: [24, 48], sinceMs: departed + (entersYallama + 8) * HOUR },
    };
    const route = routeWithWaits(HOR, { segIdx: 0, atMs: departed }, waits);
    const y = seg(route, 'uz_queue').hours;
    expect(segMid(y)).toBeCloseTo(8 + 36, 6);
    expect(y[0]).toBeCloseTo((24 * (36 + 8)) / 36, 6);
    expect(y[1]).toBeCloseTo((48 * (36 + 8)) / 36, 6);
  });

  it('(f) the Kashgar road is untouched by any typed queue', () => {
    const waits: BorderHours = {
      khorgos: { hours: [0, 0], sinceMs: NOW.getTime() },
      yallama: { hours: [240, 480], sinceMs: NOW.getTime() },
    };
    for (const [o, d] of [['KA', 'TAS1'], ['YW', 'TAS1'], ['KA', 'AND']] as const) {
      const route = routeFor(o, d)!;
      expect(routeWithWaits(route, { segIdx: 0, atMs: at(-30) }, waits), `${o}→${d}`).toEqual(route);
      const typed = scheduleEstimate(o, d, ago(30), null, waits, NOW)!;
      const none = scheduleEstimate(o, d, ago(30), null, {}, NOW)!;
      expect(typed.est, `${o}→${d}`).toEqual(none.est);
    }
  });

  it('(g) «0–0» — the queue is gone — never produces a NaN anywhere', () => {
    const waits: BorderHours = {
      khorgos: { hours: [0, 0], sinceMs: at(-1) },
      yallama: { hours: [0, 0], sinceMs: at(-1) },
    };
    for (const hoursAgo of [0, 1, 3, 10, 30, 60]) {
      const s = scheduleEstimate('HOR', 'TAS1', ago(hoursAgo), null, waits, NOW)!;
      for (const v of [s.est.x, s.est.y, s.est.progress, ...s.est.remainingHours]) {
        expect(Number.isFinite(v), `${hoursAgo} h`).toBe(true);
      }
    }
    // Pinned in a queue whose number dropped to zero: it has stood what it
    // stood, and stands no longer.
    const pinned = scheduleEstimate(
      'HOR',
      'TAS1',
      ago(40),
      { key: 'at_border', at: ago(30).toISOString() },
      { khorgos: { hours: [0, 0], sinceMs: NOW.getTime() } },
      NOW,
    )!;
    expect(Number.isFinite(pinned.est.progress)).toBe(true);
    expect(pinned.est.segKey).toBe('kz');
  });

  it('the engine reads the adjusted route exactly as it reads any route', () => {
    // routeWithWaits returns a RouteDef, nothing more: the dot and the date
    // are the engine's, so the map and the cabinet cannot disagree.
    const waits: BorderHours = { khorgos: { hours: [24, 48], sinceMs: at(0) } };
    const route = routeWithWaits(HOR, { segIdx: 0, atMs: ago(30).getTime() }, waits);
    expect(scheduleEstimate('HOR', 'TAS1', ago(30), null, waits, NOW)!.est).toEqual(
      estimateTransit(route, 30),
    );
  });
});
