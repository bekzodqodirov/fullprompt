import { describe, expect, it } from 'vitest';
import { nextClientNumber } from '@/modules/platform/clients/code';

/** Mirrors the validation in clients/actions.ts (spec 5.2: `{prefix}{digits}`). */
function isValidClientCode(code: string, prefix: string): boolean {
  return new RegExp(`^${prefix}\\d+$`).test(code);
}

describe('client code format (spec 5.2, §17 client_code_prefix)', () => {
  it('accepts prefix + digits', () => {
    expect(isValidClientCode('GS777', 'GS')).toBe(true);
    expect(isValidClientCode('GS1', 'GS')).toBe(true);
  });

  it('rejects wrong prefix, letters after prefix, empty digits', () => {
    expect(isValidClientCode('AB777', 'GS')).toBe(false);
    expect(isValidClientCode('GS77A', 'GS')).toBe(false);
    expect(isValidClientCode('GS', 'GS')).toBe(false);
    expect(isValidClientCode('777', 'GS')).toBe(false);
  });

  it('respects a changed prefix setting', () => {
    expect(isValidClientCode('KG42', 'KG')).toBe(true);
    expect(isValidClientCode('GS42', 'KG')).toBe(false);
  });
});

describe('auto code continues the MAIN sequence (owner: 425 + outliers 777/5564/5909)', () => {
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  it("the owner's exact case: 1..425 with 777, 5564, 5909 → 426, not 5910", () => {
    expect(nextClientNumber([...range(1, 425), 777, 5564, 5909])).toBe(426);
  });

  it('works the same when the sequence starts at the fresh-install 100', () => {
    // Rank-based density used to fail here until ~248 codes existed.
    expect(nextClientNumber([...range(100, 150), 5909])).toBe(151);
    expect(nextClientNumber([...range(100, 247), 5909])).toBe(248);
    expect(nextClientNumber([...range(100, 342), 777])).toBe(343);
  });

  it('ignores a moderate outlier too, not only a far-away one', () => {
    expect(nextClientNumber([...range(1, 425), 500])).toBe(426);
    expect(nextClientNumber([...range(1, 425), 700])).toBe(426);
    expect(nextClientNumber([...range(1, 600), 1000])).toBe(601);
    expect(nextClientNumber([...range(1, 60), 200])).toBe(61);
  });

  it('a pure sequence keeps behaving like before (max + 1)', () => {
    expect(nextClientNumber(range(1, 425))).toBe(426);
    expect(nextClientNumber(range(100, 342))).toBe(343);
  });

  it('empty table starts at 100 (unchanged)', () => {
    expect(nextClientNumber([])).toBe(100);
  });

  it('a handful of scattered manual codes falls back to max + 1 (never small reused numbers)', () => {
    expect(nextClientNumber([100, 200, 300])).toBe(301);
    expect(nextClientNumber([777])).toBe(778);
    // A single legacy code far below a real sequence must not win.
    expect(nextClientNumber([1, ...range(100, 200)])).toBe(201);
  });

  it('the BIGGEST group is the main sequence, wherever it sits', () => {
    expect(nextClientNumber([...range(1, 50), ...range(1000, 1300)])).toBe(1301);
    expect(nextClientNumber([...range(1, 10), ...range(30, 40)])).toBe(41);
  });

  it('once the sequence actually reaches an outlier, it skips over it', () => {
    expect(nextClientNumber([...range(1, 776), 777])).toBe(778);
    // Manual GS426 created a moment before the auto-create.
    expect(nextClientNumber([...range(1, 425), 426, 5909])).toBe(427);
  });

  it('gaps inside the sequence are never re-issued', () => {
    const withGaps = range(1, 425).filter((n) => ![17, 250, 380].includes(n));
    expect(nextClientNumber([...withGaps, 5909])).toBe(426);
  });

  it('duplicates and junk values do not shift the result', () => {
    expect(nextClientNumber([...range(1, 425), 425, 425, 5909])).toBe(426);
    expect(nextClientNumber([...range(1, 425), 0, -5, Number.NaN, 1e30])).toBe(426);
  });

  it('applies the documented 50-gap boundary, and stays monotone past it', () => {
    // Within 50 of the last code → still the same run, so continue from it.
    expect(nextClientNumber([...range(1, 425), 460])).toBe(461);
    expect(nextClientNumber([...range(1, 425), 475])).toBe(476);
    // More than 50 above → a separate special code, stepped over for good.
    for (const outlier of [476, 480, 700, 5909]) {
      expect(nextClientNumber([...range(1, 425), outlier]), `outlier ${outlier}`).toBe(426);
    }
  });
});
