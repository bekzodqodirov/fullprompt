import { describe, expect, it } from 'vitest';
import {
  DWELL_HOURS,
  pickupPosition,
  pickupTimeline,
  type LngLat,
} from '@/modules/wms/tracking/pickup-route';

/**
 * A factory truck on the map, by estimate (owner's D1). Two factories and
 * our warehouse; each leg 10 hours.
 */
const F1: LngLat = [120, 29];
const F2: LngLat = [121, 29];
const WH: LngLat = [122, 29];
const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 24, 8);

const stops = (pressed1: Date | null, pressed2: Date | null) => [
  { point: F1, collectedAt: pressed1, leg: { points: [F1, F2], hours: 10 } },
  { point: F2, collectedAt: pressed2, leg: { points: [F2, WH], hours: 10 } },
];

describe('pickupTimeline / pickupPosition', () => {
  it('stands at the first factory until the first «olindi»', () => {
    const timeline = pickupTimeline(stops(null, null))!;
    const at = pickupPosition(timeline, T0);
    expect(at).toMatchObject({ point: F1, phase: 'waiting', etaAt: null });
  });

  it('drives, loads, drives, and arrives on the schedule', () => {
    const timeline = pickupTimeline(stops(new Date(T0), null))!;
    expect(pickupPosition(timeline, T0 + 5 * H)).toMatchObject({ phase: 'driving', hopIndex: 0 });
    expect(pickupPosition(timeline, T0 + 5 * H).point[0]).toBeCloseTo(120.5, 5);
    // Arrived at factory 2, loading for DWELL_HOURS.
    expect(pickupPosition(timeline, T0 + 11 * H)).toMatchObject({ phase: 'loading', point: F2 });
    const eta = T0 + (20 + DWELL_HOURS) * H;
    expect(pickupPosition(timeline, T0 + 11 * H).etaAt).toBe(eta);
    expect(pickupPosition(timeline, eta + H)).toMatchObject({ phase: 'arrived', point: WH, overdue: true });
  });

  it('the latest press re-anchors the trip, and what lies before it is road travelled', () => {
    const second = new Date(T0 + 15 * H);
    const timeline = pickupTimeline(stops(new Date(T0), second))!;
    expect(timeline.start).toEqual(F2);
    expect(timeline.done).toEqual([[F1, F2]]);
    const at = pickupPosition(timeline, T0 + 16 * H);
    expect(at).toMatchObject({ phase: 'driving', hopIndex: 0 });
    expect(at.etaAt).toBe(second.getTime() + 10 * H);
  });

  it('B3: the driver takes factory 2 FIRST — the lorry is not sent back to factory 1', () => {
    const timeline = pickupTimeline(stops(null, new Date(T0)))!;
    expect(timeline.start).toEqual(F2);
    // Factory 1 was never driven from, so none of its road is «behind» the truck.
    expect(timeline.done).toEqual([]);
    const at = pickupPosition(timeline, T0 + 5 * H);
    expect(at.phase).toBe('driving');
    expect(at.point[0]).toBeCloseTo(121.5, 5);
    expect(at.etaAt).toBe(T0 + 10 * H);
  });

  it('never divides by a zero-hour leg', () => {
    const same = pickupTimeline([
      { point: F1, collectedAt: new Date(T0), leg: { points: [F1, F1], hours: 0 } },
    ])!;
    const at = pickupPosition(same, T0 + 60_000);
    expect(Number.isFinite(at.progress)).toBe(true);
  });
});
