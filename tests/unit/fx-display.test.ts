import { describe, expect, it } from 'vitest';
import { isRateJump, perUsd, toRateToUsd } from '@/modules/wms/costing/fx-display';

/**
 * The stored rate multiplies to dollars; people quote the other direction.
 * Getting this backwards would misprice every shipment, so both directions
 * are pinned against the two currencies the company actually uses.
 */
describe('exchange rates as people say them', () => {
  it('reads the som and the yuan the way the owner does', () => {
    expect(perUsd(0.00008)).toBe(12500); // 1 USD = 12 500 so'm
    expect(perUsd(0.13888889)).toBe(7.2); // 1 USD = 7.2 CNY
    expect(perUsd(1)).toBe(1); // USD itself
  });

  it('stores what the costing engine needs', () => {
    expect(toRateToUsd(12500)).toBe(0.00008);
    expect(toRateToUsd(7.2)).toBeCloseTo(0.13888889, 8);
  });

  it('survives the round trip in both directions', () => {
    for (const quoted of [12500, 12345, 7.2, 6.85, 1, 3.67]) {
      expect(perUsd(toRateToUsd(quoted)!)).toBe(quoted);
    }
  });

  it('refuses nonsense instead of dividing by zero', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(perUsd(bad), String(bad)).toBeNull();
      expect(toRateToUsd(bad), String(bad)).toBeNull();
    }
  });
});

describe('a rate far from the standing one is asked about (audit A1)', () => {
  it("the so'm figure typed against the yuan is a jump; a normal week's drift is not", () => {
    expect(isRateJump(7.2, 12500)).toBe(true);
    expect(isRateJump(12500, 7.2)).toBe(true);
    expect(isRateJump(7.2, 7.3)).toBe(false);
    expect(isRateJump(12500, 12700)).toBe(false);
  });

  it('the boundary is a fifth either way, and a first rate is never a jump', () => {
    expect(isRateJump(100, 120)).toBe(false);
    expect(isRateJump(100, 120.5)).toBe(true);
    expect(isRateJump(100, 79.5)).toBe(true);
    expect(isRateJump(null, 12500)).toBe(false);
  });
});
