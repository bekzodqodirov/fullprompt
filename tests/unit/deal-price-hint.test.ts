import { describe, expect, it } from 'vitest';
import {
  dealSharesOf,
  expectedForDeals,
  expectedPriceFor,
  needsConfirmation,
} from '@/modules/wms/finance/deal-price-hint';

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

describe('several prixods and deals for one client (2026-09-26, item 5)', () => {
  const lot = (dealId: string | null, receiptId: string, m3: number, kg: number) => ({
    dealId,
    dealCode: dealId ? `B-${dealId}` : null,
    m3,
    kg,
    receiptId,
  });

  it('splits the cargo by deal and counts the prixods', () => {
    const got = dealSharesOf([lot('1', 'r1', 2, 100), lot('1', 'r2', 3, 150), lot('2', 'r3', 5, 500)]);
    expect(got.receipts).toBe(3);
    expect(got.unlinkedReceipts).toBe(0);
    expect(got.shares).toEqual([
      { dealId: '1', dealCode: 'B-1', m3: 5, kg: 250, receipts: 2 },
      { dealId: '2', dealCode: 'B-2', m3: 5, kg: 500, receipts: 1 },
    ]);
  });

  it('expects the sum of each deal’s own share of its quote', () => {
    const quotes = new Map([
      ['1', { amount: 1000, currency: 'USD', m3: 10, kg: null }],
      ['2', { amount: 600, currency: 'USD', m3: 5, kg: null }],
    ]);
    const { shares } = dealSharesOf([lot('1', 'r1', 5, 0), lot('2', 'r2', 5, 0)]);
    // Half of deal 1 (500) and all of deal 2 (600).
    expect(expectedForDeals(quotes, shares, 0)).toBe(1100);
  });

  it('says nothing when part of the cargo has no deal or no dollar quote', () => {
    const quotes = new Map([['1', { amount: 1000, currency: 'USD', m3: 10, kg: null }]]);
    const { shares, unlinkedReceipts } = dealSharesOf([lot('1', 'r1', 5, 0), lot(null, 'r2', 1, 0)]);
    expect(unlinkedReceipts).toBe(1);
    expect(expectedForDeals(quotes, shares, unlinkedReceipts)).toBeNull();
    const som = new Map([['1', { amount: 1000, currency: 'UZS', m3: 10, kg: null }]]);
    expect(expectedForDeals(som, dealSharesOf([lot('1', 'r1', 5, 0)]).shares, 0)).toBeNull();
  });
});
