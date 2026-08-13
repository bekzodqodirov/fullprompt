import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { etaWindow, scheduleEstimate } from '@/modules/wms/tracking/eta';

const HOUR = 3_600_000;
const NOW = new Date('2026-08-12T09:00:00.000Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

describe('scheduleEstimate — the owner’s own corridor timings', () => {
  it('needs a route AND a departure', () => {
    expect(scheduleEstimate('YW', 'KA', null, null, NOW)).toBeNull();
    // A pair the map does not know: honest silence, not an invented road.
    expect(scheduleEstimate('NOPE', 'ALSONOPE', ago(10), null, NOW)).toBeNull();
  });

  it('a truck that left Yiwu an hour ago is about a week from Kashgar', () => {
    // map-data.ts: YW→KA is 144-168 hours, his own number.
    const s = scheduleEstimate('YW', 'KA', ago(1), null, NOW)!;
    expect(s.est.overdue).toBe(false);
    const [min, max] = s.est.remainingHours;
    expect(min).toBeGreaterThan(120);
    expect(max).toBeLessThanOrEqual(168);
  });

  it('runs out of schedule rather than promising for ever', () => {
    const s = scheduleEstimate('YW', 'KA', ago(400), null, NOW)!;
    expect(s.est.overdue).toBe(true);
    expect(s.est.remainingHours).toEqual([0, 0]);
    // And then it says nothing: «taxminan kecha» is worse than silence while
    // the office finds out where the truck is.
    expect(etaWindow(s.est, NOW)).toBeNull();
  });

  it('the operator’s pin re-anchors the clock', () => {
    // The border wait is the one leg no schedule can predict — the owner's own
    // note in map-data.ts says 1-3 days «sometimes more». A truck pinned AT
    // THE BORDER an hour ago has the whole wait plus Kyrgyzstan plus
    // Uzbekistan left, however long ago it actually departed.
    const pinned = scheduleEstimate(
      'KA',
      'TAS1',
      ago(500),
      { key: 'at_border', at: ago(1).toISOString() },
      NOW,
    )!;
    expect(pinned.est.overdue).toBe(false);
    expect(pinned.est.segKey).toBe('border_wait');
    // Without the pin the same truck is long overdue — which is exactly the
    // drift the pin exists to correct.
    const unpinned = scheduleEstimate('KA', 'TAS1', ago(500), null, NOW)!;
    expect(unpinned.est.overdue).toBe(true);
  });

  it('a pin inside Uzbekistan leaves only the last leg', () => {
    const s = scheduleEstimate('KA', 'TAS1', ago(300), { key: 'in_uz', at: ago(2).toISOString() }, NOW)!;
    expect(s.est.segKey).toBe('uz');
    // Osh → Tashkent over the Kamchik pass: 36-48 hours, less the two spent.
    expect(s.est.remainingHours[1]).toBeLessThanOrEqual(48);
  });
});

describe('etaWindow — two dates, never one', () => {
  it('turns the remaining hours into a window a person can read', () => {
    const s = scheduleEstimate('YW', 'KA', ago(1), null, NOW)!;
    const w = etaWindow(s.est, NOW)!;
    expect(new Date(w.fromIso).getTime()).toBeGreaterThan(NOW.getTime());
    expect(new Date(w.toIso).getTime()).toBeGreaterThan(new Date(w.fromIso).getTime());
    // The window IS the schedule's own range, offset from now.
    expect((new Date(w.fromIso).getTime() - NOW.getTime()) / HOUR).toBeCloseTo(
      s.est.remainingHours[0],
      0,
    );
  });
});

describe('the map and the customer read one schedule', () => {
  /**
   * Source-shape, because both versions WORK: the anchoring rule (a checkpoint
   * replaces the elapsed clock with the time since the pin) is subtle enough
   * that a second copy would drift, and then the truck on the operator's map
   * and the date in the customer's phone would say different things about the
   * same lorry (#513).
   */
  it('truck.ts asks the shared assembler and does not estimate on its own', () => {
    const src = readFileSync('src/modules/wms/tracking/truck.ts', 'utf8');
    expect(src).toContain('scheduleEstimate(');
    expect(src).not.toContain('estimateTransit(');
    expect(src).not.toContain('CHECKPOINT_SEGMENTS');
  });

  it('the cabinet asks the same one', () => {
    const src = readFileSync('src/modules/wms/client-cabinet/service.ts', 'utf8');
    expect(src).toContain('scheduleEstimate(');
    expect(src).toContain('etaWindow(');
  });
});
