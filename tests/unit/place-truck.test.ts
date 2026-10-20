import { describe, expect, it } from 'vitest';
import { chordDeg, cumulativeLengths, type RoutePoint } from '@/modules/wms/tracking/engine';
import { placeTruck, scheduleEstimate, type PlacementFix } from '@/modules/wms/tracking/eta';
import { routeFor } from '@/modules/wms/tracking/map-data';
import {
  LEG_ZONE,
  zoneOfGenericRoad,
  zoneOfRoute,
  zoneOfWarehouse,
} from '@/modules/wms/tracking/place';

/**
 * Where a truck is (docs/PARTIYA-DOSKASI.md §2): the schedule walked from the
 * NEWEST evidence — the departure, the logist's pin, or the driver's fix.
 *
 * The oracles are the road's own geometry (`cumulativeLengths` over
 * `routeFor`'s points, measured here, not read back from the function under
 * test) and literal numbers where the point is the switch from days to
 * distance (#166: a test comparing the engine to itself cannot see 4a).
 */

const HOUR = 3_600_000;
const NOW = new Date('2026-08-27T04:00:00.000Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);
const KA_TAS = { originCode: 'KA', destCode: 'TAS1', originCountry: 'CN', destCountry: 'UZ' };
const HOR_TAS = { originCode: 'HOR', destCode: 'TAS1', originCountry: 'CN', destCountry: 'UZ' };
const fixAt = (p: RoutePoint, hoursAgo: number, source = 'device'): PlacementFix => ({
  lat: p.y,
  lon: p.x,
  recordedAt: ago(hoursAgo),
  source,
});
/** A point `deg` from `from` towards `to`. */
const toward = (from: RoutePoint, to: RoutePoint, deg: number): RoutePoint => {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  return { x: from.x + ((to.x - from.x) / len) * deg, y: from.y + ((to.y - from.y) / len) * deg };
};

const kaTas = routeFor('KA', 'TAS1')!;
const kaCum = cumulativeLengths(kaTas.points);
const kaTotal = kaCum[kaCum.length - 1]!;
const kaPost = kaTas.segments.find((s) => s.key === 'border_wait')!.span[0];

describe('the place vocabulary', () => {
  it('a warehouse is placed by its type and country, never its code', () => {
    expect(zoneOfWarehouse('CN', 'hub')).toBe('border');
    expect(zoneOfWarehouse(' cn ', 'origin')).toBe('cn');
    expect(zoneOfWarehouse('UZ', 'distribution')).toBe('uz');
    expect(zoneOfWarehouse('KZ', 'hub')).toBeNull();
    expect(zoneOfWarehouse(null, null)).toBeNull();
  });

  it('the road from the border hub to the post is «at the border»', () => {
    // As `cn` a Horgos truck read Chegara → Xitoy ichida → Chegarada.
    expect(LEG_ZONE.to_border).toBe('border');
    expect(LEG_ZONE.border_wait).toBe('border');
    expect(LEG_ZONE.uz_queue).toBe('border');
    expect(LEG_ZONE.kg).toBe('transit');
    expect(LEG_ZONE.kz).toBe('transit');
    expect(LEG_ZONE.cn_transit).toBe('cn');
    expect(LEG_ZONE.uz).toBe('uz');
  });

  it('a generic road is placed by its two ends, a road by its one place', () => {
    expect(zoneOfGenericRoad('CN', 'CN')).toBe('cn');
    expect(zoneOfGenericRoad('UZ', 'uz')).toBe('uz');
    expect(zoneOfGenericRoad('UZ', 'CN')).toBeNull();
    expect(zoneOfRoute(routeFor('YW', 'KA')!)).toBe('cn');
    expect(zoneOfRoute(kaTas)).toBeNull();
  });
});

describe('the road % is the LENGTH behind the truck (4a)', () => {
  it('Yiwu → Tashkent three days out reads 39 %, where the days read 24 %', () => {
    // The literal anchor of the switch: 72 h of a 296 h schedule is 24 %,
    // and the Chinese road is long and fast, so the truck is 39 % along it.
    const place = placeTruck({ originCode: 'YW', destCode: 'TAS1', originCountry: 'CN', destCountry: 'UZ', departedAt: ago(72), checkpoint: null }, {}, NOW);
    expect(Math.round(place.progress! * 100)).toBe(39);
    expect(place.zone).toBe('cn');
    expect(place.source).toBe('schedule');
    // The schedule's own estimate is the same walk.
    expect(scheduleEstimate('YW', 'TAS1', ago(72), null, {}, NOW)!.est.progress).toBe(place.progress);
  });

  it('a truck in the queue keeps its % for the whole wait — the road up to the post', () => {
    const early = placeTruck({ ...KA_TAS, departedAt: ago(30), checkpoint: null }, {}, NOW);
    const late = placeTruck({ ...KA_TAS, departedAt: ago(60), checkpoint: null }, {}, NOW);
    expect(early.segKey).toBe('border_wait');
    expect(late.segKey).toBe('border_wait');
    expect(early.zone).toBe('border');
    expect(early.progress).toBeCloseTo(kaCum[kaPost]! / kaTotal, 10);
    expect(late.progress).toBeCloseTo(kaCum[kaPost]! / kaTotal, 10);
  });
});

describe('a fix places the truck (5a)', () => {
  const kg = kaTas.segments.find((s) => s.key === 'kg')!;
  const mid = Math.floor((kg.span[0] + kg.span[1]) / 2);

  it('on its leg, at its own point, dated by the fix', () => {
    const place = placeTruck(
      { ...KA_TAS, departedAt: ago(100), checkpoint: null, fix: fixAt(kaTas.points[mid]!, 1) },
      {},
      NOW,
    );
    expect(place.segKey).toBe('kg');
    expect(place.zone).toBe('transit');
    expect(place.source).toBe('gps');
    expect(place.fresh).toBe(true);
    expect(place.evidenceAt).toBe(ago(1).toISOString());
    // The fix's own share of the road, walked on one hour.
    expect(place.progress!).toBeGreaterThanOrEqual(kaCum[mid]! / kaTotal);
    expect(place.progress!).toBeLessThan(kaCum[mid]! / kaTotal + 0.02);
    // Fresh: the dot is the fix (on the road), not the walk.
    expect(place.point).toEqual(kaTas.points[mid]);
  });

  it('near the post on the road leading to it, it is IN the queue — Irkeshtam too', () => {
    const near = toward(kaTas.points[kaPost]!, kaTas.points[kaPost - 1]!, 0.02);
    const place = placeTruck(
      { ...KA_TAS, departedAt: ago(13), checkpoint: null, fix: fixAt(near, 0.5) },
      {},
      NOW,
    );
    expect(place.segKey).toBe('border_wait');
    expect(place.zone).toBe('border');
    // The schedule would reach the post 5 h from now, so the truck entered
    // at the fix: the whole wait (24-72 h, half an hour stood) plus the two
    // legs after it (36-48 h each).
    expect(place.remainingHours).toEqual([96, 167]);
  });

  it('just past the post it is on the next leg — a truck past Yallama is in Uzbekistan', () => {
    const hor = routeFor('HOR', 'TAS1')!;
    const yal = hor.segments.find((s) => s.key === 'uz_queue')!.span[0];
    const past = toward(hor.points[yal]!, hor.points[yal + 1]!, 0.02);
    expect(chordDeg(past, hor.points[yal]!)).toBeLessThan(0.05);
    const place = placeTruck({ ...HOR_TAS, departedAt: ago(150), checkpoint: null, fix: fixAt(past, 1) }, {}, NOW);
    expect(place.segKey).toBe('uz');
    expect(place.zone).toBe('uz');

    // The same distance on the Kazakh side is the queue, entered when the
    // schedule put the truck there (52 h ago), before the fix.
    const approach = toward(hor.points[yal]!, hor.points[yal - 1]!, 0.02);
    const queued = placeTruck({ ...HOR_TAS, departedAt: ago(150), checkpoint: null, fix: fixAt(approach, 1) }, {}, NOW);
    expect(queued.segKey).toBe('uz_queue');
    expect(queued.zone).toBe('border');
    expect(queued.remainingHours).toEqual([29, 43]);
  });

  it('a stale fix still anchors: the truck walks on from it, it does not jump back', () => {
    const start = kaTas.points[kg.span[0] + 4]!;
    const withFix = placeTruck({ ...KA_TAS, departedAt: ago(200), checkpoint: null, fix: fixAt(start, 30) }, {}, NOW);
    const without = placeTruck({ ...KA_TAS, departedAt: ago(200), checkpoint: null }, {}, NOW);
    // Departure alone: 200 h is past the whole schedule.
    expect(without.overdue).toBe(true);
    // Seen in Kyrgyzstan 30 h ago: still in Kyrgyzstan, walking, with a date.
    expect(withFix.overdue).toBe(false);
    expect(withFix.segKey).toBe('kg');
    expect(withFix.fresh).toBe(false);
    expect(withFix.source).toBe('gps');
    expect(withFix.remainingHours).not.toBeNull();
    // Not fresh: the dot is the walk's, ahead of the old fix.
    expect(withFix.point).not.toEqual(start);
  });

  it('a fix from before the departure, a coarse one off the road, places nothing', () => {
    const fromYard = placeTruck(
      { ...KA_TAS, departedAt: ago(10), checkpoint: null, fix: fixAt(kaTas.points[mid]!, 11) },
      {},
      NOW,
    );
    expect(fromYard.source).toBe('schedule');
    const offRoad = placeTruck(
      { ...KA_TAS, departedAt: ago(10), checkpoint: null, fix: fixAt({ x: 80, y: 45 }, 1) },
      {},
      NOW,
    );
    expect(offRoad.source).toBe('schedule');
  });
});

describe('the newest evidence wins', () => {
  const kg = kaTas.segments.find((s) => s.key === 'kg')!;
  const late = kaTas.points[kg.span[1] - 3]!;

  it('a pin newer than the fix on a LATER leg moves the truck on', () => {
    const toBorder = kaTas.points[4]!;
    const place = placeTruck(
      {
        ...KA_TAS,
        departedAt: ago(60),
        checkpoint: { key: 'in_kg', at: ago(2).toISOString() },
        fix: fixAt(toBorder, 10),
      },
      {},
      NOW,
    );
    expect(place.source).toBe('pin');
    expect(place.segKey).toBe('kg');
  });

  it('a pin newer than the fix on the fix\'s OWN leg keeps the fix — «in Kyrgyzstan» is not its start', () => {
    const pinned = placeTruck(
      {
        ...KA_TAS,
        departedAt: ago(120),
        checkpoint: { key: 'in_kg', at: ago(2).toISOString() },
        fix: fixAt(late, 3),
      },
      {},
      NOW,
    );
    expect(pinned.source).toBe('gps');
    expect(pinned.progress!).toBeGreaterThanOrEqual(kaCum[kg.span[1] - 3]! / kaTotal);
  });

  it('a fix newer than the pin wins', () => {
    const place = placeTruck(
      {
        ...KA_TAS,
        departedAt: ago(120),
        checkpoint: { key: 'at_border', at: ago(40).toISOString() },
        fix: fixAt(late, 1),
      },
      {},
      NOW,
    );
    expect(place.source).toBe('gps');
    expect(place.segKey).toBe('kg');
  });
});

describe('overdue: where the newest evidence last put it', () => {
  it('nothing but the departure: the road\'s one place, or «Joyi aniq emas» — and no %', () => {
    const china = placeTruck({ originCode: 'YW', destCode: 'KA', originCountry: 'CN', destCountry: 'CN', departedAt: ago(400), checkpoint: null }, {}, NOW);
    expect(china.overdue).toBe(true);
    expect(china.zone).toBe('cn');
    expect(china.progress).toBeNull();
    expect(china.remainingHours).toBeNull();
    const across = placeTruck({ ...KA_TAS, departedAt: ago(400), checkpoint: null }, {}, NOW);
    expect(across.zone).toBeNull();
    expect(across.segKey).toBeNull();
  });

  it('a pin: its leg, at the start of it', () => {
    const place = placeTruck(
      { ...KA_TAS, departedAt: ago(400), checkpoint: { key: 'at_border', at: ago(300).toISOString() } },
      {},
      NOW,
    );
    expect(place.overdue).toBe(true);
    expect(place.segKey).toBe('border_wait');
    expect(place.zone).toBe('border');
    expect(place.progress).toBeCloseTo(kaCum[kaPost]! / kaTotal, 10);
    expect(place.point).toEqual(kaTas.points[kaPost]);
  });
});

describe('no road to walk', () => {
  it('a generic road is still somewhere when its ends agree, and a pin says Uzbekistan', () => {
    const china = placeTruck({ originCode: 'YW', destCode: 'GZ', originCountry: 'CN', destCountry: 'CN', departedAt: ago(10), checkpoint: null }, {}, NOW);
    expect(china.route).toBeNull();
    expect(china.zone).toBe('cn');
    expect(china.progress).toBeNull();
    const pinned = placeTruck(
      { originCode: 'TAS1', destCode: 'AND', originCountry: 'UZ', destCountry: 'UZ', departedAt: ago(10), checkpoint: { key: 'in_uz', at: ago(1).toISOString() } },
      {},
      NOW,
    );
    expect(pinned.segKey).toBe('uz');
    expect(pinned.source).toBe('pin');
    const unknown = placeTruck({ originCode: 'QOQ', destCode: 'NAM', originCountry: null, destCountry: null, departedAt: ago(10), checkpoint: null }, {}, NOW);
    expect(unknown.zone).toBeNull();
    expect(unknown.source).toBeNull();
  });
});

/**
 * The fixes' own review (2026-10-20). Each case is a literal scenario the
 * verifiers measured against the shipped code, and each asserts the place
 * the BUSINESS reads — the leg, overdue or not — never the engine against
 * itself.
 */
describe('a queue the fix disproves is counted from the fix', () => {
  it('Irkeshtam: 78 h out, the phone in the queue — still at the border, the whole wait ahead', () => {
    // The schedule had the truck enter 60 h ago and cross 12 h ago (24-72 h,
    // mid 48); the phone, half an hour ago, says it is still in the queue.
    const near = toward(kaTas.points[kaPost]!, kaTas.points[kaPost - 1]!, 0.02);
    const place = placeTruck({ ...KA_TAS, departedAt: ago(78), checkpoint: null, fix: fixAt(near, 0.5) }, {}, NOW);
    expect(place.segKey).toBe('border_wait');
    expect(place.zone).toBe('border');
    // Entered at the fix: the queue less the half-hour stood, then kg and uz.
    expect(place.remainingHours).toEqual([96, 167]);
  });

  it('Khorgos, 96 h late: in the queue, at the road up to the post', () => {
    const hor = routeFor('HOR', 'TAS1')!;
    const post = hor.segments.find((s) => s.key === 'border_wait')!.span[0];
    const near = toward(hor.points[post]!, hor.points[post - 1]!, 0.02);
    // Schedule: 2 h to the post, 72 h in the queue — out 74 h after leaving.
    const place = placeTruck({ ...HOR_TAS, departedAt: ago(170), checkpoint: null, fix: fixAt(near, 0.5) }, {}, NOW);
    expect(place.segKey).toBe('border_wait');
    expect(place.overdue).toBe(false);
  });

  it('Yallama, 96 h late: in the queue, not overdue', () => {
    const hor = routeFor('HOR', 'TAS1')!;
    const yal = hor.segments.find((s) => s.key === 'uz_queue')!.span[0];
    const approach = toward(hor.points[yal]!, hor.points[yal - 1]!, 0.02);
    const place = placeTruck({ ...HOR_TAS, departedAt: ago(280), checkpoint: null, fix: fixAt(approach, 1) }, {}, NOW);
    expect(place.segKey).toBe('uz_queue');
    expect(place.overdue).toBe(false);
    expect(place.remainingHours![0]).toBeGreaterThan(0);
  });
});

describe('an older fix under a newer pin on the same leg', () => {
  it('the phone went quiet 100 h ago in the Irkeshtam queue, the logist pressed «Chegarada» 2 h ago: at the border', () => {
    const near = toward(kaTas.points[kaPost]!, kaTas.points[kaPost - 1]!, 0.02);
    const place = placeTruck(
      {
        ...KA_TAS,
        departedAt: ago(120),
        checkpoint: { key: 'at_border', at: ago(2).toISOString() },
        fix: fixAt(near, 100),
      },
      {},
      NOW,
    );
    // Walked from the fix the truck crossed days ago; the press says no.
    expect(place.segKey).toBe('border_wait');
    expect(place.source).toBe('pin');
  });

  it('the phone 30 h ago mid-Kazakhstan, «Qozog‘istonda» 2 h ago: in Kazakhstan, never behind the phone', () => {
    const hor = routeFor('HOR', 'TAS1')!;
    const horCum = cumulativeLengths(hor.points);
    const horTotal = horCum[horCum.length - 1]!;
    const kz = hor.segments.find((s) => s.key === 'kz')!;
    const at = Math.floor((kz.span[0] + kz.span[1]) / 2);
    const place = placeTruck(
      {
        ...HOR_TAS,
        departedAt: ago(200),
        checkpoint: { key: 'in_kz', at: ago(2).toISOString() },
        fix: fixAt(hor.points[at]!, 30),
      },
      {},
      NOW,
    );
    // Walked from the fix (18-30 h for the whole leg) it had reached Yallama
    // by the press; the press says it was still in Kazakhstan.
    expect(place.segKey).toBe('kz');
    expect(place.source).toBe('gps');
    expect(place.progress!).toBeGreaterThanOrEqual(horCum[at]! / horTotal);
  });
});

describe('a truck ahead of its schedule is not overdue', () => {
  const tas = kaTas.points[kaTas.points.length - 1]!;

  it('the phone at the Tashkent yard, 75 h after leaving Kashgar: at the gate, nothing left, not overdue', () => {
    const place = placeTruck({ ...KA_TAS, departedAt: ago(75), checkpoint: null, fix: fixAt(tas, 2) }, {}, NOW);
    expect(place.overdue).toBe(false);
    expect(place.remainingHours).toEqual([0, 0]);
    expect(place.segKey).toBe('uz');
    expect(place.zone).toBe('uz');
    expect(place.source).toBe('gps');
  });

  it('12 km before the yard, two hours on, and overnight at the yard: still not overdue', () => {
    const before = toward(tas, kaTas.points[kaTas.points.length - 2]!, 0.11);
    const near = placeTruck({ ...KA_TAS, departedAt: ago(70), checkpoint: null, fix: fixAt(before, 2) }, {}, NOW);
    expect(near.overdue).toBe(false);
    const night = placeTruck({ ...KA_TAS, departedAt: ago(85), checkpoint: null, fix: fixAt(tas, 12) }, {}, NOW);
    expect(night.overdue).toBe(false);
    expect(night.remainingHours).toEqual([0, 0]);
  });

  it('once the schedule runs out too, it is overdue — at the fix, not on the warehouse', () => {
    const before = toward(tas, kaTas.points[kaTas.points.length - 2]!, 0.11);
    const place = placeTruck({ ...KA_TAS, departedAt: ago(200), checkpoint: null, fix: fixAt(before, 30) }, {}, NOW);
    expect(place.overdue).toBe(true);
    expect(place.remainingHours).toBeNull();
    expect(place.point).toEqual(before);
  });
});

describe('overdue with nothing but the departure is drawn nowhere', () => {
  it('a spent walk ends on the destination warehouse — no point, so no lorry «arrived» on it', () => {
    const across = placeTruck({ ...KA_TAS, departedAt: ago(800), checkpoint: null }, {}, NOW);
    expect(across.overdue).toBe(true);
    expect(across.point).toBeNull();
    const china = placeTruck({ originCode: 'YW', destCode: 'KA', originCountry: 'CN', destCountry: 'CN', departedAt: ago(800), checkpoint: null }, {}, NOW);
    expect(china.point).toBeNull();
  });
});
