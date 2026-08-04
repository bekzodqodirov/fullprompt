import { describe, expect, it } from 'vitest';
import { allArrived, compareQuote, worthAlerting } from '@/modules/wms/deals/deviation';

/**
 * The quote-versus-reality calculation, called directly.
 *
 * The owner's own example is the first case, verbatim: quoted 1 m³ / 100 kg
 * for 200 USD, the cargo turns up at 1.4 m³. Every other case here is one of
 * the situations he described — a shipment split over two days, cargo that
 * came out SMALLER than quoted, cargo sent with no quote at all.
 */
describe('quote versus reality', () => {
  const QUOTE = { volumeM3: 1, weightKg: 100, amount: 200 };

  it("the owner's case: 1 m³ quoted, 1.4 m³ arrived", () => {
    const result = compareQuote(QUOTE, { volumeM3: 1.4, weightKg: 100 }, 10);
    expect(result.volumePct).toBeCloseTo(40, 6);
    expect(result.weightPct).toBe(0);
    expect(result.driver).toBe('volume');
    expect(result.exceeds).toBe(true);
    // 200 × 1.4 — the figure the manager opens the conversation with.
    expect(result.suggestedAmount).toBe(280);
  });

  it('stays quiet inside the threshold', () => {
    const result = compareQuote(QUOTE, { volumeM3: 1.05, weightKg: 103 }, 10);
    expect(result.exceeds).toBe(false);
    expect(result.worstPct).toBeCloseTo(5, 6);
  });

  it('fires exactly AT the threshold, not one hair past it', () => {
    // 10 % must mean 10 %. An exclusive comparison here would silently raise
    // the owner's setting to "just over 10", which is not what he set.
    expect(compareQuote(QUOTE, { volumeM3: 1.1, weightKg: 100 }, 10).exceeds).toBe(true);
  });

  it('shouts about cargo that came out SMALLER too', () => {
    // The client charged for 1 m³ who shipped 0.6 complains just as loudly,
    // and is right to.
    const result = compareQuote(QUOTE, { volumeM3: 0.6, weightKg: 100 }, 10);
    expect(result.worstPct).toBeCloseTo(-40, 6);
    expect(result.exceeds).toBe(true);
    expect(result.suggestedAmount).toBe(120);
  });

  it('lets the measure that moved furthest decide', () => {
    // Light bulky cargo: the volume is fine, the weight is double. Taking the
    // first non-null measure instead would have reported "within quote".
    const result = compareQuote(QUOTE, { volumeM3: 1.02, weightKg: 200 }, 10);
    expect(result.driver).toBe('weight');
    expect(result.worstPct).toBeCloseTo(100, 6);
    expect(result.suggestedAmount).toBe(400);
  });

  it('says so when there is nothing to compare against', () => {
    const result = compareQuote({ volumeM3: null, weightKg: null, amount: 200 }, { volumeM3: 1.4, weightKg: 90 }, 10);
    expect(result.incomparable).toBe(true);
    expect(result.exceeds).toBe(false);
    expect(result.suggestedAmount).toBeNull();
  });

  it('treats a zero quote as no quote rather than as an infinite overrun', () => {
    // A salesperson who typed 0 into the volume box has not quoted a volume.
    // Dividing by it would report Infinity % and send an alert saying nothing.
    const result = compareQuote({ volumeM3: 0, weightKg: null, amount: 200 }, { volumeM3: 1.4, weightKg: 90 }, 10);
    expect(result.volumePct).toBeNull();
    expect(result.incomparable).toBe(true);
  });

  it('compares against the WHOLE job when a shipment is split', () => {
    // Half today, half tomorrow — a real pattern here. The first half alone
    // reads as 50 % under; only both halves together are the truth.
    const firstHalf = compareQuote(QUOTE, { volumeM3: 0.5, weightKg: 50 }, 10);
    expect(firstHalf.worstPct).toBeCloseTo(-50, 6);
    const bothHalves = compareQuote(QUOTE, { volumeM3: 1.0, weightKg: 100 }, 10);
    expect(bothHalves.exceeds).toBe(false);
  });

  it('rounds the suggested amount to money, not to floating point', () => {
    const result = compareQuote(
      { volumeM3: 3, weightKg: null, amount: 100 },
      { volumeM3: 3.333, weightKg: 0 },
      1,
    );
    expect(result.suggestedAmount).toBe(111.1);
  });

  it('offers no amount when there was no price to scale', () => {
    const result = compareQuote({ volumeM3: 1, weightKg: null, amount: null }, { volumeM3: 1.4, weightKg: 0 }, 10);
    expect(result.exceeds).toBe(true);
    expect(result.suggestedAmount).toBeNull();
  });
});

describe('which gaps are worth a message', () => {
  const QUOTE = { volumeM3: 1, weightKg: 100, amount: 200 };

  it('pushes an overrun and stays silent on a shortfall', () => {
    // Found by the integration test, not by review: comparing on `exceeds`
    // alone sent a false alarm every time half a split shipment landed.
    expect(worthAlerting(compareQuote(QUOTE, { volumeM3: 1.4, weightKg: 100 }, 10))).toBe(true);
    expect(worthAlerting(compareQuote(QUOTE, { volumeM3: 0.5, weightKg: 50 }, 10))).toBe(false);
  });

  it('says nothing when there is nothing to compare, and nothing when it fits', () => {
    expect(worthAlerting(compareQuote(QUOTE, { volumeM3: 1.02, weightKg: 100 }, 10))).toBe(false);
    expect(
      worthAlerting(
        compareQuote({ volumeM3: null, weightKg: null, amount: 200 }, { volumeM3: 9, weightKg: 9 }, 10),
      ),
    ).toBe(false);
  });
});

describe('"until every box has arrived"', () => {
  it('is not satisfied by a deal with no boxes at all', () => {
    // Otherwise a deferral granted before the cargo ships would expire
    // instantly, which is the opposite of what was agreed.
    expect(allArrived({ total: 0, pending: 0 })).toBe(false);
  });

  it('holds while anything is still outstanding, and releases when nothing is', () => {
    expect(allArrived({ total: 10, pending: 1 })).toBe(false);
    expect(allArrived({ total: 10, pending: 0 })).toBe(true);
  });
});
