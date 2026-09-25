import { describe, expect, it } from 'vitest';
import { arrearsUsd, closingRule, paidSoFar, remainderOf } from '@/modules/wms/accounting/recurring-math';

/**
 * The arithmetic of a recurring month (owner's Q6) — the one rule the pay
 * fold and the service both ask, and the Balans line's money.
 */

describe('what is still owed on a month', () => {
  const salary = { amount: 900, currency: 'USD' };

  it('is the template less its parts, in its own currency', () => {
    expect(remainderOf(salary, [], 'USD')).toBe(900);
    expect(remainderOf(salary, [{ amount: 500, currency: 'USD' }], 'USD')).toBe(400);
    // Floors at zero: an overpaid instalment is not a credit.
    expect(remainderOf(salary, [{ amount: 1000, currency: 'USD' }], 'USD')).toBe(0);
  });

  it('cannot be known across currencies — never a converted guess', () => {
    expect(remainderOf(salary, [], 'UZS')).toBeNull();
    expect(remainderOf(salary, [{ amount: 1_000_000, currency: 'UZS' }], 'USD')).toBeNull();
  });

  it('closes by amount only when the remainder is known and reached (O3)', () => {
    expect(closingRule(salary, [], { amount: 900, currency: 'USD' })).toBe('closes');
    expect(closingRule(salary, [{ amount: 500, currency: 'USD' }], { amount: 400, currency: 'USD' })).toBe('closes');
    expect(closingRule(salary, [], { amount: 899.99, currency: 'USD' })).toBe('choose');
    expect(closingRule(salary, [], { amount: 8_900_000, currency: 'UZS' })).toBe('choose');
    // 0.1 + 0.2 must not decide a salary.
    expect(closingRule({ amount: 0.3, currency: 'USD' }, [{ amount: 0.1, currency: 'USD' }], { amount: 0.2, currency: 'USD' })).toBe(
      'closes',
    );
  });

  it('says «paid so far» as one sum only when every part is in the template’s money', () => {
    expect(paidSoFar([{ amount: 500, currency: 'USD' }, { amount: 100, currency: 'USD' }], 'USD')).toBe('600 USD');
    expect(paidSoFar([{ amount: 500, currency: 'USD' }, { amount: 1_000_000, currency: 'UZS' }], 'USD')).toBe(
      '500 USD + 1,000,000 UZS',
    );
  });
});

describe('arrears as money (M5)', () => {
  const rates = new Map<string, number | null>([
    ['USD', 1],
    ['UZS', 0.00008],
    ['CNY', null],
  ]);

  it('subtracts a part paid in another currency in dollars', () => {
    const out = arrearsUsd([{ amount: 800, currency: 'USD', cash: true, paidUsd: 300 }], rates);
    expect(out).toMatchObject({ count: 1, cashCount: 1, usd: 500 });
    const som = arrearsUsd([{ amount: 1_300_000, currency: 'UZS', cash: true, paidUsd: 4 }], rates);
    expect(som.usd).toBe(100);
  });

  it('floors a month at zero', () => {
    expect(arrearsUsd([{ amount: 100, currency: 'USD', cash: true, paidUsd: 150 }], rates).usd).toBe(0);
  });

  it('counts a book entry and adds no dollars for it', () => {
    const out = arrearsUsd([{ amount: 50, currency: 'USD', cash: false, paidUsd: 0 }], rates);
    expect(out).toEqual({ count: 1, cashCount: 0, usd: 0, unrated: [] });
  });

  it('names an unrated currency in its own money and never counts it as $0 of the line', () => {
    const out = arrearsUsd(
      [
        { amount: 77, currency: 'CNY', cash: true, paidUsd: 0 },
        { amount: 23, currency: 'CNY', cash: true, paidUsd: 0 },
        { amount: 10, currency: 'USD', cash: true, paidUsd: 0 },
      ],
      rates,
    );
    expect(out.usd).toBe(10);
    expect(out.cashCount).toBe(1);
    expect(out.count).toBe(3);
    expect(out.unrated).toEqual([{ currency: 'CNY', amount: 100, count: 2 }]);
  });
});
