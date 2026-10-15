import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import en from '../../messages/en.json';
import ru from '../../messages/ru.json';
import uz from '../../messages/uz.json';
import zh from '../../messages/zh-CN.json';
import {
  LADDER_LITERAL,
  LADDER_STEPS,
  RAW_MAX,
  bandBounds,
  clippedSide,
  domainOf,
  histogram,
  position,
  prevLine,
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

  it('keeps its edges inclusive where floating point would shave them', () => {
    // 0.4 × 0.75 is 0.30000000000000004: a 0.3 kg declaration — four
    // decimals, compared exactly by postgres — fell outside its own band.
    expect(bandBounds(0.4)).toEqual({ lo: 0.3, hi: 0.5 });
    expect(bandBounds(0.0004)).toEqual({ lo: 0.0003, hi: 0.0005 });
    // A per-piece weight read off kg / qty carries the same noise.
    expect(bandBounds(0.7 / 7)).toEqual({ lo: 0.075, hi: 0.125 });
    // A bound that is not a four-decimal number stays where it is: around a
    // 0.41 g piece the band starts at 0.0003075, so a stored 0.0003 is
    // still outside it and 0.0004 inside.
    const odd = bandBounds(0.00041)!;
    expect(odd.lo).toBeCloseTo(0.0003075, 15);
    expect(odd.lo > 0.0003 && odd.lo < 0.0004).toBe(true);
    const third = bandBounds(10 / 3)!;
    expect(third.lo).toBe(2.5);
    expect(third.hi > 4.1666 && third.hi < 4.1667).toBe(true);
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

describe('the «oldingi chorak» line (D7)', () => {
  it('asks emptiness BEFORE the country split', () => {
    expect(prevLine(null, true)).toBe('missing');
    // Nothing of this code in the previous file: no split to differ — on
    // either flag, and on the undecided one the source now sends.
    expect(prevLine({ n: 0, p50: null, filtered: null }, true)).toBe('none');
    expect(prevLine({ n: 0, p50: null, filtered: false }, true)).toBe('none');
    expect(prevLine({ n: 0, p50: null, filtered: true }, false)).toBe('none');
    // Two real medians: like for like, or no comparison.
    expect(prevLine({ n: 3, p50: 3, filtered: false }, true)).toBe('scope');
    expect(prevLine({ n: 3, p50: 3, filtered: true }, true)).toBe('median');
    expect(prevLine({ n: 3, p50: 3, filtered: false }, false)).toBe('median');
  });
});

describe('the clipped tails, said in words', () => {
  it('names only the end that really has something beyond it', () => {
    expect(clippedSide(null)).toBeNull();
    expect(clippedSide({ clippedLow: 0, clippedHigh: 0 })).toBeNull();
    expect(clippedSide({ clippedLow: 0.05, clippedHigh: 0.05 })).toBe('both');
    expect(clippedSide({ clippedLow: 0.05, clippedHigh: 0 })).toBe('low');
    expect(clippedSide({ clippedLow: 0, clippedHigh: 0.05 })).toBe('high');
    // The big sample's own domain, with a min equal to p5: only the top end.
    expect(clippedSide(domainOf(big))).toBe('both');
    expect(clippedSide(domainOf({ ...big, min: bigLadder[4]! }))).toBe('high');
  });
});

describe('the one-sided clip sentence renders in every language', () => {
  // An ICU select that does not parse is a FORMATTING_ERROR at render time —
  // existence of the key (i18n-keys.test.ts) cannot see it (#520's lesson).
  it('says which end, and never the other one', () => {
    for (const [locale, messages] of [['uz', uz], ['ru', ru], ['en', en], ['zh-CN', zh]] as const) {
      const t = createTranslator({ locale, messages, namespace: 'calc' });
      const low = t('statsClippedSide', { side: 'low' });
      const high = t('statsClippedSide', { side: 'high' });
      expect(low, locale).toContain('5 %');
      expect(high, locale).toContain('5 %');
      expect(low, locale).not.toBe(high);
      expect(low, locale).not.toContain('{');
    }
  });
});
