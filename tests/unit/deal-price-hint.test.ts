import { describe, expect, it } from 'vitest';
import { expectedPriceFor, needsConfirmation } from '@/modules/wms/finance/deal-price-hint';

const quote = { amount: 4800, currency: 'USD', m3: 30, kg: 1500 };

describe('the deal price beside the truck price (his item 7, 2026-09-26)', () => {
  it('scales the quote by this truck’s share of the quoted m³', () => {
    expect(expectedPriceFor(quote, { m3: 20, kg: 900 })).toBe(3200);
  });
  it('falls back to kg, then to the whole quote', () => {
    expect(expectedPriceFor({ ...quote, m3: null }, { m3: 20, kg: 750 })).toBe(2400);
    expect(expectedPriceFor({ ...quote, m3: null, kg: null }, { m3: 20, kg: 750 })).toBe(4800);
  });
  it('compares only a dollar quote, and never an empty one', () => {
    expect(expectedPriceFor({ ...quote, currency: 'UZS' }, { m3: 20, kg: 900 })).toBeNull();
    expect(expectedPriceFor({ ...quote, amount: null }, { m3: 20, kg: 900 })).toBeNull();
  });
  it('asks above 5 %, either way, and not at exactly 5 %', () => {
    expect(needsConfirmation(3200, 3200)).toBe(false);
    expect(needsConfirmation(3360, 3200)).toBe(false); // +5 % exactly
    expect(needsConfirmation(3361, 3200)).toBe(true);
    expect(needsConfirmation(3000, 3200)).toBe(true); // −6.25 %
    expect(needsConfirmation(3000, null)).toBe(false);
  });
});
