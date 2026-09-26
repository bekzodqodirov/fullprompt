import { describe, expect, it } from 'vitest';
import { refundFits } from '@/modules/wms/finance/service';
import { crossCloseRefusal } from '@/modules/wms/finance/fx-close';

/**
 * U5 (0103, design §5.5.7): the refund cap in the refund's own money when the
 * client holds an advance in it and owes nothing else — 125,000,000 so'm
 * handed back in full after the rate moved — and wc's dollar rule otherwise.
 * With the pure admission of the accountant's two-currency close beside it.
 */
describe('refundFits', () => {
  const somAdvance = [{ currency: 'UZS', native: -125_000_000, usd: -10_000 }];

  it('a so’m advance with nothing owed elsewhere: the whole advance, whatever its dollars read now', () => {
    expect(refundFits({ amount: 125_000_000, currency: 'UZS', amountUsd: 10_245.9 }, somAdvance)).toBe(true);
    expect(refundFits({ amount: 125_000_001, currency: 'UZS', amountUsd: 10_245.91 }, somAdvance)).toBe(false);
  });

  it('owing dollars keeps the dollar rule (2 % or $5 over the advance)', () => {
    const owes = [...somAdvance, { currency: 'USD', native: 100, usd: 100 }];
    expect(refundFits({ amount: 125_000_000, currency: 'UZS', amountUsd: 10_245.9 }, owes)).toBe(false);
    expect(refundFits({ amount: 120_000_000, currency: 'UZS', amountUsd: 9_836.07 }, owes)).toBe(true);
  });

  it('a DOLLAR advance handed back in so’m drifts by nothing: only the $5 floor over it (review)', () => {
    // 2 % of the whole advance let $10,000 hand back $10,200 of so'm.
    const dollars = [{ currency: 'USD', native: -10_000, usd: -10_000 }];
    expect(refundFits({ amount: 124_687_500, currency: 'UZS', amountUsd: 10_150 }, dollars)).toBe(false);
    expect(refundFits({ amount: 122_550_000, currency: 'UZS', amountUsd: 10_004 }, dollars)).toBe(true);
  });

  it('no advance in the refund’s currency: the dollar rule', () => {
    const dollars = [{ currency: 'USD', native: -300, usd: -300 }];
    expect(refundFits({ amount: 306, currency: 'USD', amountUsd: 306 }, dollars)).toBe(false);
    expect(refundFits({ amount: 300, currency: 'USD', amountUsd: 300 }, dollars)).toBe(true);
    expect(refundFits({ amount: 1, currency: 'USD', amountUsd: 1 }, [])).toBe(false);
  });
});

describe('crossCloseRefusal', () => {
  it('only a small residue on an account that really moves in two currencies', () => {
    expect(crossCloseRefusal({ balanceUsd: 0, paidUsd: 100, currencies: 2 })).toBe('fx_close_nothing');
    expect(crossCloseRefusal({ balanceUsd: 2.34, paidUsd: 97.66, currencies: 1 })).toBe('fx_close_single_currency');
    expect(crossCloseRefusal({ balanceUsd: 2.34, paidUsd: 97.66, currencies: 2 })).toBeNull();
    expect(crossCloseRefusal({ balanceUsd: -4.99, paidUsd: 10, currencies: 2 })).toBeNull();
    // 2 % of $1,000 = $20 beats $5.
    expect(crossCloseRefusal({ balanceUsd: 20, paidUsd: 1000, currencies: 2 })).toBeNull();
    expect(crossCloseRefusal({ balanceUsd: 20.01, paidUsd: 1000, currencies: 2 })).toBe('fx_close_too_large');
  });
});
