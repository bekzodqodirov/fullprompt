import { describe, expect, it } from 'vitest';
import {
  ceilCents,
  exactSharesOf,
  expectedForDeals,
  expectedHereFor,
  expectedPartFor,
  expectedPriceFor,
  needsConfirmation,
  prefillFor,
  type DealQuote,
  type PrefillFacts,
} from '@/modules/wms/finance/deal-price-hint';

/**
 * The price table's pre-fill (the owner's 1a/2a, 2026-11-08: each row filled
 * with the deal's own sold price for its cargo on this truck, for the owner
 * and the accountant) — a PURE rule, because a pre-fill is one tap from a
 * bill. The figures are literals worked by hand, never the code restated.
 */
const facts = (over: Partial<PrefillFacts> = {}): PrefillFacts => ({
  sight: true,
  partUsd: 205.74,
  quoted: true,
  discounted: false,
  pricedHere: false,
  zeroed: false,
  pricedCard: false,
  pricedOn: [],
  follows: false,
  continuation: false,
  offElsewhere: false,
  whole: false,
  ...over,
});

describe('expectedPartFor — a deal’s part on one truck, for a bill', () => {
  const quote = { amount: 5000, currency: 'USD', m3: 30, kg: 6000 };

  it('scales on the quote’s m³ and rounds UP: 5000 × 1.2344 / 30 = 205.7333… → 205.74', () => {
    expect(expectedPartFor(quote, { m3: 1.2344, kg: 0 }, false)).toEqual({ usd: 205.74, basis: 'm3' });
  });

  it('scales per kg when the deal’s freight was priced per kg — the upsale’s own basis', () => {
    // 5000 × 1500 / 6000 = 1250 exactly, never 1250.01 by floating point.
    expect(expectedPartFor(quote, { m3: 1.2344, kg: 1500 }, true)).toEqual({ usd: 1250, basis: 'kg' });
  });

  it('falls to kg only when the quote has no m³', () => {
    expect(expectedPartFor({ ...quote, m3: null }, { m3: 2, kg: 600 }, false)).toEqual({ usd: 500, basis: 'kg' });
  });

  it('never the WHOLE quote: no measure on the quote, or none on its basis here, has no part (judge F5)', () => {
    expect(expectedPartFor({ ...quote, m3: null, kg: null }, { m3: 2, kg: 600 }, false)).toBeNull();
    // The quote's basis is m³ and the cargo here has none — not a kg fallback.
    expect(expectedPartFor(quote, { m3: 0, kg: 600 }, false)).toBeNull();
    // …while the 5 % hint keeps its whole-quote fallback, for a hint.
    expect(expectedPriceFor({ ...quote, m3: null, kg: null }, { m3: 2, kg: 600 })).toBe(5000);
  });

  it('only a positive dollar quote', () => {
    expect(expectedPartFor({ ...quote, currency: 'UZS' }, { m3: 1, kg: 0 }, false)).toBeNull();
    expect(expectedPartFor({ ...quote, amount: 0 }, { m3: 1, kg: 0 }, false)).toBeNull();
    expect(expectedPartFor({ ...quote, amount: null }, { m3: 1, kg: 0 }, false)).toBeNull();
  });
});

describe('expectedHereFor — the figure a row is compared with is the pre-fill’s own (review B1)', () => {
  // A sealed per-kg version (the open top band): $1000 for 10 m³ / 2000 kg,
  // and 11 m³ / 1900 kg of it aboard. Worked by hand: by kg 1000 × 1900 /
  // 2000 = $950 — the upsale's own basis; by m³ 1000 × 11 / 10 = $1100.
  const perKgQuote = { amount: 1000, currency: 'USD', m3: 10, kg: 2000 };
  const aboard = { m3: 11, kg: 1900 };

  it('an untouched per-kg pre-fill raises no 5 % question about itself', () => {
    const part = expectedPartFor(perKgQuote, aboard, true);
    expect(part).toEqual({ usd: 950, basis: 'kg' });
    const prefill = prefillFor(facts({ partUsd: part!.usd }), 'USD');
    expect(prefill).toEqual({ usd: 950 });
    const compared = expectedHereFor(perKgQuote, aboard, aboard, true);
    expect(compared).toBe(950);
    expect(needsConfirmation(950, compared)).toBe(false);
    // The m³-first hint the row used to compare with called the system's own
    // figure 14 % cheap — and its «≈ $1100» billed $150 over the sale.
    expect(expectedPriceFor(perKgQuote, aboard)).toBe(1100);
    expect(needsConfirmation(950, 1100)).toBe(true);
  });

  it('keeps the hint’s fallback where no part can be stated — a warning, never a bill', () => {
    // No measure on the quote: the whole quote, as the hint always said.
    expect(expectedHereFor({ ...perKgQuote, m3: null, kg: null }, aboard, aboard, false)).toBe(1000);
    // No exact share (nothing to scale): the rounded share's m³-first figure.
    expect(expectedHereFor(perKgQuote, aboard, undefined, true)).toBe(1100);
    expect(expectedHereFor(perKgQuote, undefined, undefined, true)).toBeNull();
  });

  it('the deal block’s total is the sum of the same per-deal figures', () => {
    const quotes = new Map<string, DealQuote>([
      ['A', perKgQuote],
      ['B', { amount: 600, currency: 'USD', m3: 5, kg: null }],
    ]);
    const shares = [
      { dealId: 'A', dealCode: 'B-1', m3: 11, kg: 1900, receipts: 1 },
      { dealId: 'B', dealCode: 'B-2', m3: 1.2344, kg: 0, receipts: 1 },
    ];
    const exact = new Map([
      ['A', aboard],
      ['B', { m3: 1.2344, kg: 0 }],
    ]);
    // 950 (A by kg) + 600 × 1.2344 / 5 = 148.128 → up 148.13 (B by m³).
    expect(expectedForDeals(quotes, shares, 0, { exact, perKg: (dealId) => dealId === 'A' })).toBe(1098.13);
  });
});

describe('ceilCents', () => {
  it('rounds a fraction of a cent up, and leaves a whole cent where it is', () => {
    expect(ceilCents(205.7333)).toBe(205.74);
    expect(ceilCents(205.7301)).toBe(205.74);
    expect(ceilCents((1000 * 0.3) / 0.3)).toBe(1000);
    expect(ceilCents(0.1 + 0.2)).toBe(0.3);
  });
});

describe('exactSharesOf — the truck’s share, never rounded', () => {
  it('sums each own deal’s lots by boxes aboard over boxes in the lot, at the stored precision', () => {
    const shares = exactSharesOf(
      [
        { dealId: 'A', dealClientId: 'C1', lotM3: 1.2344, lotKg: 100, onBatch: 1, lotBoxCount: 1 },
        { dealId: 'A', dealClientId: 'C1', lotM3: 3, lotKg: 30, onBatch: 1, lotBoxCount: 3 },
        // Another client's deal through a re-assigned prixod: not this client's.
        { dealId: 'X', dealClientId: 'C9', lotM3: 9, lotKg: 9, onBatch: 1, lotBoxCount: 1 },
        { dealId: null, dealClientId: null, lotM3: 9, lotKg: 9, onBatch: 1, lotBoxCount: 1 },
      ],
      'C1',
    );
    expect([...shares.keys()]).toEqual(['A']);
    expect(shares.get('A')!.m3).toBeCloseTo(2.2344, 10);
    expect(shares.get('A')!.kg).toBeCloseTo(110, 10);
  });
});

describe('prefillFor — a value only when nothing on the page says the cargo is priced', () => {
  it('pre-fills the stated part, in dollars, for the quote sight', () => {
    expect(prefillFor(facts(), 'USD')).toEqual({ usd: 205.74 });
  });

  it('never for the VED (law 4) — whatever else is true', () => {
    expect(prefillFor(facts({ sight: false }), 'USD')).toEqual({ none: 'sight' });
  });

  it('names each exclusion, in the order the row says it', () => {
    expect(prefillFor(facts({ continuation: true, whole: true }), 'USD')).toEqual({ none: 'continuation' });
    expect(prefillFor(facts({ whole: true, pricedHere: true }), 'USD')).toEqual({ none: 'whole' });
    expect(prefillFor(facts({ offElsewhere: true }), 'USD')).toEqual({ none: 'off_elsewhere' });
    expect(prefillFor(facts({ pricedHere: true }), 'USD')).toEqual({ none: 'priced_here' });
    // A part the lost-cargo door gave back is still a price someone set —
    // pre-filled, the next press bills it again (review A1).
    expect(prefillFor(facts({ zeroed: true }), 'USD')).toEqual({ none: 'zeroed' });
    expect(prefillFor(facts({ pricedCard: true }), 'USD')).toEqual({ none: 'priced_card' });
    // A deal split over two trucks: pre-filled on the first only.
    expect(prefillFor(facts({ pricedOn: ['YW-009'] }), 'USD')).toEqual({ none: 'priced_elsewhere' });
    expect(prefillFor(facts({ follows: true }), 'USD')).toEqual({ none: 'follows' });
    expect(prefillFor(facts({ quoted: false }), 'USD')).toEqual({ none: 'no_quote' });
    // Gross of a damage discount the card nets: never a bill (judge P1-UX-2).
    expect(prefillFor(facts({ discounted: true }), 'USD')).toEqual({ none: 'discount' });
    expect(prefillFor(facts({ partUsd: null }), 'USD')).toEqual({ none: 'unscaled' });
  });

  it('a dollar figure is never put in a so’m box', () => {
    expect(prefillFor(facts(), 'UZS')).toEqual({ none: 'currency' });
    // …and a row with nothing to state says THAT, not «dollars only».
    expect(prefillFor(facts({ partUsd: null }), 'UZS')).toEqual({ none: 'unscaled' });
  });
});
