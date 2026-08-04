import { describe, expect, it } from 'vitest';
import { estimateTransit } from '@/modules/wms/tracking/engine';
import { CHECKPOINT_SEGMENTS, routeFor } from '@/modules/wms/tracking/map-data';

/** Tracking simulation (owner's corridor timings). */

const KA_TAS = routeFor('KA', 'TAS1')!;
/**
 * The border, asked of the ROUTE rather than counted by hand. It used to be
 * `points[1]`, which stopped being true the moment the corridor learned the
 * road it actually drives (round 47) — the same brittleness the spans
 * themselves had.
 */
const BORDER = KA_TAS.points[KA_TAS.segments.find((s) => s.key === 'border_wait')!.span[0]]!;

describe('routeFor', () => {
  it('knows the owner corridors and falls back to a straight line', () => {
    expect(routeFor('YW', 'KA')).not.toBeNull();
    expect(routeFor('GZ', 'KA')).not.toBeNull();
    expect(routeFor('KA', 'AND')).not.toBeNull();
    expect(routeFor('KA', 'TAS1')).not.toBeNull();
    expect(routeFor('AND', 'TAS2')).not.toBeNull();
    // Mapped pair without a defined corridor → generic straight line.
    const generic = routeFor('YW', 'TAS1')!;
    expect(generic.points).toHaveLength(2);
    // Unknown warehouse → no truck on the map.
    expect(routeFor('NOPE', 'TAS1')).toBeNull();
  });

  it('KA→UZ schedule matches the owner timings (border 1-3d, KG 2d, UZ 2d)', () => {
    const keys = KA_TAS.segments.map((s) => s.key);
    expect(keys).toEqual(['to_border', 'border_wait', 'kg', 'uz']);
    const border = KA_TAS.segments.find((s) => s.key === 'border_wait')!;
    expect(border.hours).toEqual([24, 72]);
    expect(border.span[0]).toBe(border.span[1]); // stationary
  });
});

describe('estimateTransit', () => {
  it('starts at the origin and ends at the destination', () => {
    const start = estimateTransit(KA_TAS, 0);
    expect(start.x).toBeCloseTo(KA_TAS.points[0]!.x, 0);
    expect(start.segKey).toBe('to_border');
    expect(start.overdue).toBe(false);

    const end = estimateTransit(KA_TAS, 10_000);
    const last = KA_TAS.points[KA_TAS.points.length - 1]!;
    expect(end.x).toBeCloseTo(last.x, 0);
    expect(end.overdue).toBe(true);
    expect(end.remainingHours).toEqual([0, 0]);
  });

  it('sits at the border during the wait window and moves on after', () => {
    // to_border mid = 18h; border_wait mid = 48h → at 30h we are waiting.
    const waiting = estimateTransit(KA_TAS, 30);
    expect(waiting.segKey).toBe('border_wait');
    expect(waiting.x).toBeCloseTo(BORDER.x, 5);
    expect(waiting.y).toBeCloseTo(BORDER.y, 5);

    // 18 + 48 + 1 → into Kyrgyzstan.
    const kg = estimateTransit(KA_TAS, 68);
    expect(kg.segKey).toBe('kg');
  });

  it('progress and remaining time shrink monotonically', () => {
    const a = estimateTransit(KA_TAS, 10);
    const b = estimateTransit(KA_TAS, 60);
    const c = estimateTransit(KA_TAS, 120);
    expect(b.progress).toBeGreaterThan(a.progress);
    expect(c.progress).toBeGreaterThan(b.progress);
    expect(b.remainingHours[1]).toBeLessThan(a.remainingHours[1]);
    expect(c.remainingHours[0]).toBeLessThanOrEqual(b.remainingHours[0]);
  });

  it('a checkpoint re-anchors the clock (truck stuck at the border)', () => {
    // Without a pin, 10 days in the schedule would say "in UZ / arrived".
    const noPin = estimateTransit(KA_TAS, 240);
    expect(['uz']).toContain(noPin.segKey);

    // The logist pinned "at the border" 5 hours ago → the map holds it there.
    const pinned = estimateTransit(KA_TAS, 240, {
      segKey: CHECKPOINT_SEGMENTS.at_border!,
      elapsedInSegHours: 5,
    });
    expect(pinned.segKey).toBe('border_wait');
    expect(pinned.x).toBeCloseTo(BORDER.x, 5);
    // Remaining time counts from the pin, not from departure.
    expect(pinned.remainingHours[1]).toBeGreaterThan(noPin.remainingHours[1]);
  });

  it('an unknown anchor key falls back to plain elapsed-time estimation', () => {
    const est = estimateTransit(KA_TAS, 30, { segKey: 'bogus', elapsedInSegHours: 1 });
    expect(est.segKey).toBe('border_wait');
  });
});
