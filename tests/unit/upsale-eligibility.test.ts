import { describe, expect, it } from 'vitest';
import { MONEY_EPSILON, upsaleEligible, upsaleOf } from '@/modules/wms/calc/upsale';

/**
 * Law 4's hardest clause: «ANY discount kills the upsale right — a freight
 * discount included» (owner: «yo'lkiradan tushirganda ham upsale o'chsin»).
 */
const facts = (over: Partial<Parameters<typeof upsaleEligible>[0]> = {}) => ({
  discountUsd: 0,
  density: 50,
  bandOverrideMin: null,
  ...over,
});

describe('any concession kills the upsale', () => {
  it('a clean job keeps it', () => {
    expect(upsaleEligible(facts())).toBe(true);
  });

  it('a typed discount kills it, however small', () => {
    expect(upsaleEligible(facts({ discountUsd: 50 }))).toBe(false);
    expect(upsaleEligible(facts({ discountUsd: 0.5 }))).toBe(false);
    // …but a rounding hair is not a discount.
    expect(upsaleEligible(facts({ discountUsd: MONEY_EPSILON }))).toBe(true);
  });

  it('a band override that LOWERS the freight is a concession', () => {
    // The real density is 250; forcing the freight into the 1-100 band buys a
    // cheaper rate, which is a discount wearing the tariff's clothes.
    expect(upsaleEligible(facts({ density: 250, bandOverrideMin: 1 }))).toBe(false);
    expect(upsaleEligible(facts({ density: 250, bandOverrideMin: 249 }))).toBe(false);
  });

  it('a band override that RAISES it is not — the VED is charging MORE', () => {
    // An overstated m³ corrected upward concedes nothing to the customer.
    expect(upsaleEligible(facts({ density: 250, bandOverrideMin: 301 }))).toBe(true);
    expect(upsaleEligible(facts({ density: 250, bandOverrideMin: 250 }))).toBe(true);
  });

  it('an override with no density at all fails CLOSED', () => {
    // A money rule that cannot tell whether something was conceded must not
    // answer «no concession».
    expect(upsaleEligible(facts({ density: null, bandOverrideMin: 100 }))).toBe(false);
    // With no override, a missing density decides nothing and is fine.
    expect(upsaleEligible(facts({ density: null }))).toBe(true);
  });

  it('refuses a NaN discount rather than reading it as zero', () => {
    // NaN answers false to every comparison, so `> EPSILON` would pass it.
    expect(upsaleEligible(facts({ discountUsd: Number('1 000') }))).toBe(false);
  });
});

describe('the seller’s share', () => {
  it('is the client price minus the floor, to the cent', () => {
    expect(upsaleOf({ clientPriceUsd: 4500, totalUsd: 3764 })).toBe(736);
    expect(upsaleOf({ clientPriceUsd: 3764.55, totalUsd: 3764 })).toBe(0.55);
  });

  it('is nothing at the floor, and nothing below it', () => {
    expect(upsaleOf({ clientPriceUsd: 3764, totalUsd: 3764 })).toBeNull();
    // A loss is not a commission.
    expect(upsaleOf({ clientPriceUsd: 3000, totalUsd: 3764 })).toBeNull();
  });

  it('refuses a number it had to invent', () => {
    expect(upsaleOf({ clientPriceUsd: Number('abc'), totalUsd: 3764 })).toBeNull();
    expect(upsaleOf({ clientPriceUsd: 4500, totalUsd: Number('1 000') })).toBeNull();
  });
});
