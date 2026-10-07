import { describe, expect, it } from 'vitest';
import {
  LADDER_LITERAL,
  LADDER_STEPS,
  RAW_MAX,
  bandBounds,
  domainOf,
  histogram,
  position,
  sampleOf,
  seriesFromRaw,
  type SeriesStats,
} from '@/modules/wms/customs/import-stats-math';

/**
 * The arithmetic of «Narxlar statistikasi» (his C1-C6) — pure, shared by the
 * server and the browser, so it is tested here and not through a screen.
 */

const series = (over: Partial<SeriesStats>): SeriesStats => ({
  n: 0,
  min: null,
  max: null,
  p25: null,
  p50: null,
  p75: null,
  ladder: null,
  prices: null,
  exemplars: { p25: null, p50: null, p75: null },
  ...over,
});

/** A 99-step ladder over 1..99 (a big sample, n > RAW_MAX). */
const bigLadder = LADDER_STEPS.map((_, i) => i + 1);
const big = series({ n: 500, min: 0.5, max: 400, ladder: bigLadder, p25: 25, p50: 50, p75: 75 });

describe('the ladder', () => {
  it('has 99 steps and carries 0.25/0.50/0.75 at 24/49/74', () => {
    expect(LADDER_STEPS).toHaveLength(99);
    expect(LADDER_STEPS[24]).toBe(0.25);
    expect(LADDER_STEPS[49]).toBe(0.5);
    expect(LADDER_STEPS[74]).toBe(0.75);
    expect(LADDER_LITERAL.startsWith('{0.01,0.02')).toBe(true);
    expect(LADDER_LITERAL.endsWith('0.98,0.99}')).toBe(true);
  });

  it('a ladder step weighs 1/99; a raw price weighs 1/n', () => {
    expect(sampleOf(big).weight).toBeCloseTo(1 / 99, 12);
    expect(sampleOf(series({ n: 4, prices: [1, 2, 3, 4] })).weight).toBe(0.25);
    expect(sampleOf(series({ n: 0 }))).toEqual({ values: [], weight: 0 });
  });

  it('the response carries the ladder only above RAW_MAX and the prices only at or under it', () => {
    const raw = { n: 6, min: '1.0000', max: '6.0000', ladder: LADDER_STEPS.map(() => '3.0000'), prices: ['1', '2', '3', '4', '5', '6'] };
    const small = seriesFromRaw(raw);
    expect(small.ladder).toBeNull();
    expect(small.prices).toEqual([1, 2, 3, 4, 5, 6]);
    expect(small.p50).toBe(3);
    const wide = seriesFromRaw({ ...raw, n: RAW_MAX + 1, prices: null });
    expect(wide.ladder).toHaveLength(99);
    expect(wide.prices).toBeNull();
  });
});

describe('the histogram', () => {
  it('raw shares sum to 1 and every value lands in exactly one bin', () => {
    const s = series({ n: 7, min: 1, max: 9, prices: [1, 1.5, 2, 3, 5, 8, 9] });
    const d = domainOf(s)!;
    const h = histogram(sampleOf(s), d);
    const total = h.bins.reduce((a, b) => a + b.share, 0) + h.clippedLow + h.clippedHigh;
    expect(total).toBeCloseTo(1, 9);
    // One vote each: seven values, seven sevenths, none counted twice.
    const sevenths = h.bins.reduce((a, b) => a + Math.round(b.share * 7), 0);
    expect(sevenths).toBe(7);
    expect(h.clippedLow + h.clippedHigh).toBe(0);
  });

  it('n > RAW_MAX clips at ladder[4] and ladder[94], 5 % and 5 %, never into the end bins', () => {
    const d = domainOf(big)!;
    expect(d.lo).toBe(bigLadder[4]);
    expect(d.hi).toBe(bigLadder[94]);
    expect(d.clippedLow).toBe(0.05);
    expect(d.clippedHigh).toBe(0.05);
    const h = histogram(sampleOf(big), d);
    // Four ladder steps below p5 and four above p95 — counted aside.
    expect(h.clippedLow).toBeCloseTo(4 / 99, 12);
    expect(h.clippedHigh).toBeCloseTo(4 / 99, 12);
    const total = h.bins.reduce((a, b) => a + b.share, 0) + h.clippedLow + h.clippedHigh;
    expect(total).toBeCloseTo(1, 9);
  });

  it('n <= RAW_MAX does not clip', () => {
    const d = domainOf(series({ n: 3, min: 1, max: 50, prices: [1, 2, 50] }))!;
    expect(d.lo).toBe(1);
    expect(d.hi).toBe(50);
    expect(d.clippedLow).toBe(0);
    expect(d.clippedHigh).toBe(0);
  });

  it('a single value is one bin', () => {
    const s = series({ n: 3, min: 2.4, max: 2.4, prices: [2.4, 2.4, 2.4] });
    const d = domainOf(s)!;
    expect(d.lo).toBe(d.hi);
    const h = histogram(sampleOf(s), d);
    expect(h.bins).toHaveLength(1);
    expect(h.bins[0]!.share).toBeCloseTo(1, 12);
  });

  it('a spread of four times or more is drawn on a log scale', () => {
    expect(domainOf(series({ n: 2, min: 1, max: 3.9, prices: [1, 3.9] }))!.log).toBe(false);
    expect(domainOf(series({ n: 2, min: 1, max: 4, prices: [1, 4] }))!.log).toBe(true);
  });
});

describe('his ±25 % weight band', () => {
  it('is 0.75..1.25 around one kilogram a piece, and nothing for no weight', () => {
    expect(bandBounds(1)).toEqual({ lo: 0.75, hi: 1.25 });
    expect(bandBounds(null)).toBeNull();
    expect(bandBounds(0)).toBeNull();
    expect(bandBounds(Number.NaN)).toBeNull();
    expect(bandBounds(-2)).toBeNull();
  });
});

describe('the marker position', () => {
  const d = { lo: 1, hi: 5, log: false, clippedLow: 0, clippedHigh: 0 };
  it('is never placed at NaN', () => {
    expect(position(Number.NaN, d)).toBeNull();
    expect(position(Number.POSITIVE_INFINITY, d)).toBeNull();
    expect(position(Number.NEGATIVE_INFINITY, d)).toBeNull();
  });
  it('is 0..100 inside, and clamped with its flag outside', () => {
    expect(position(3, d)).toEqual({ pct: 50, clamped: null });
    expect(position(0.2, d)).toEqual({ pct: 0, clamped: 'low' });
    expect(position(9, d)).toEqual({ pct: 100, clamped: 'high' });
  });
});
