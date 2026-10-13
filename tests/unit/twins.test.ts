import { describe, expect, it } from 'vitest';
import {
  mustWarn,
  sumCosts,
  sumTwinShape,
  twinAckOf,
  twinAckToken,
  twinCure,
  twinShape,
  twinView,
  type TwinCost,
  type TwinExpense,
} from '@/modules/wms/accounting/twins';
import { MERGE_DAYS } from '@/modules/wms/accounting/cost-merge';

/**
 * The twin rule's truth table (docs/SARFLAR.md §8.1), over the PURE decider
 * the warning and the map's count both read. The fixtures are literals, not
 * a second statement of the rule: each row is a payment as the office types
 * it on two books.
 */

const KASSA = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_KASSA = 'aaaaaaaa-0000-4000-8000-000000000002';
const FIRM = 'bbbbbbbb-0000-4000-8000-000000000001';
const OTHER_FIRM = 'bbbbbbbb-0000-4000-8000-000000000002';

const cost = (over: Partial<TwinCost> = {}): TwinCost => ({
  amount: 500,
  currency: 'USD',
  amountUsd: 500,
  costDate: '2026-10-10',
  accountId: null,
  accountAmount: null,
  partnerId: null,
  payer: 'none',
  ...over,
});
const expense = (over: Partial<TwinExpense> = {}): TwinExpense => ({
  amount: 500,
  currency: 'USD',
  amountUsd: 500,
  expenseDate: '2026-10-10',
  accountId: null,
  partnerId: null,
  payer: 'cash',
  restored: false,
  ...over,
});
/** A $500 customs bill paid out of the som kassa: 6 300 000 so'm left it. */
const somKassaCost = cost({ payer: 'kassa', accountId: KASSA, accountAmount: 6_300_000 });
const somKassaExpense = expense({
  payer: 'kassa',
  accountId: KASSA,
  amount: 6_300_000,
  currency: 'UZS',
  amountUsd: 498.1,
});

describe('one kassa on both books — the drawer debited twice', () => {
  it('is matched in the KASSA’s currency, to the cent — a dollar bill and a so’m expense are one payment', () => {
    expect(twinShape(somKassaCost, somKassaExpense)).toBe('same_kassa');
  });

  it('a different kassa, or a so’m off, is not the same payment', () => {
    expect(twinShape(somKassaCost, { ...somKassaExpense, accountId: OTHER_KASSA })).toBeNull();
    expect(twinShape(somKassaCost, { ...somKassaExpense, amount: 6_300_001 })).toBeNull();
  });

  it('carries no FX band: the drawer’s own figure either agrees or it does not', () => {
    // 2 % of 6 300 000 is 126 000 — a band would have called this a twin.
    expect(twinShape(somKassaCost, { ...somKassaExpense, amount: 6_250_000 })).toBeNull();
  });

  it('only within the merge window, unless an un-merge restored the expense', () => {
    const far = { ...somKassaExpense, expenseDate: '2026-10-25' };
    expect(twinShape(somKassaCost, far)).toBeNull();
    expect(twinShape(somKassaCost, { ...far, restored: true })).toBe('same_kassa');
    expect(MERGE_DAYS).toBe(14);
    expect(twinShape(somKassaCost, { ...somKassaExpense, expenseDate: '2026-10-24' })).toBe('same_kassa');
  });
});

describe('the other shapes, each with its own words and cure', () => {
  it('a kassa-paid cost and a kassa-less cash expense: the P&L doubled, cured by a void', () => {
    const shape = twinShape(cost({ payer: 'kassa', accountId: KASSA, accountAmount: 500 }), expense());
    expect(shape).toBe('kassa_cash');
    expect(twinCure(shape!)).toBe('void');
  });

  it('the same counterparty on both books: the debt booked twice', () => {
    expect(
      twinShape(cost({ payer: 'firm', partnerId: FIRM }), expense({ payer: 'firm', partnerId: FIRM })),
    ).toBe('same_partner');
    expect(
      twinShape(cost({ payer: 'firm', partnerId: FIRM }), expense({ payer: 'firm', partnerId: OTHER_FIRM })),
    ).toBeNull();
    expect(
      twinShape(cost({ payer: 'staff', partnerId: FIRM }), expense({ payer: 'firm', partnerId: FIRM })),
    ).toBeNull();
  });

  it('a debt on one book paid out of a kassa as an EXPENSE on the other (J4), both ways round', () => {
    expect(twinShape(cost({ payer: 'firm', partnerId: FIRM }), expense({ payer: 'kassa', accountId: KASSA }))).toBe(
      'debt_paid',
    );
    // Its cure is a payment on the counterparty, never «void one of them».
    expect(twinCure('debt_paid')).toBe('repay');
    expect(twinCure('same_partner')).toBe('void');
    expect(
      twinShape(cost({ payer: 'kassa', accountId: KASSA, accountAmount: 500 }), expense({ payer: 'staff', partnerId: FIRM })),
    ).toBe('debt_paid');
  });

  it('M4a’s own pair is the one the merge cures', () => {
    expect(twinShape(cost(), expense())).toBe('mergeable');
    expect(twinShape(cost(), expense({ payer: 'kassa', accountId: KASSA }))).toBe('mergeable');
    expect(twinCure('mergeable')).toBe('merge');
  });

  it('a BOOK expense (depreciation) moves no money and is never a twin', () => {
    for (const payer of ['kassa', 'staff', 'firm', 'none'] as const) {
      expect(twinShape(cost({ payer, accountId: payer === 'kassa' ? KASSA : null }), expense({ payer: 'book' }))).toBeNull();
    }
  });

  it('a kassa-less cost against a counterparty expense is a different payer, not a twin', () => {
    expect(twinShape(cost(), expense({ payer: 'firm', partnerId: FIRM }))).toBeNull();
  });
});

describe('the money rule outside one kassa is M4a’s', () => {
  it('another currency: within 2 % or $5 of each other in dollars', () => {
    const cny = cost({ amount: 3600, currency: 'CNY', amountUsd: 500 });
    // $5 is the looser under $250; 2 % above it — of the EXPENSE's dollars.
    expect(twinShape(cny, expense({ amountUsd: 504.99 }))).toBe('mergeable');
    expect(twinShape(cny, expense({ amount: 510, amountUsd: 510 }))).toBe('mergeable'); // 2 % of 510 = 10.2
    expect(twinShape(cny, expense({ amount: 515, amountUsd: 515 }))).toBeNull(); // 15 > 10.3
    expect(twinShape(cost({ amount: 1440, currency: 'CNY', amountUsd: 200 }), expense({ amount: 204.9, amountUsd: 204.9 }))).toBe('mergeable');
    expect(twinShape(cost({ amount: 1440, currency: 'CNY', amountUsd: 200 }), expense({ amount: 205.1, amountUsd: 205.1 }))).toBeNull();
  });

  it('a cost with no dollars cannot be compared across currencies — never guessed', () => {
    expect(twinShape(cost({ currency: 'CNY', amount: 3600, amountUsd: null }), expense())).toBeNull();
  });
});

describe('sums (J11)', () => {
  it('two truck bills of one day and one payer equal one expense', () => {
    const a = cost({ amount: 300, amountUsd: 300 });
    const b = cost({ amount: 200, amountUsd: 200 });
    expect(sumTwinShape([a, b], expense())).toBe('mergeable');
    expect(sumTwinShape([a, b], expense({ amount: 501, amountUsd: 501 }))).toBeNull();
  });

  it('a kassa sum adds what left the drawer, not the bills’ own currency', () => {
    const a = cost({ payer: 'kassa', accountId: KASSA, amount: 300, accountAmount: 3_780_000 });
    const b = cost({ payer: 'kassa', accountId: KASSA, amount: 200, accountAmount: 2_520_000 });
    expect(sumTwinShape([a, b], somKassaExpense)).toBe('same_kassa');
  });

  it('a single cost is not a sum, and two payers are never one', () => {
    expect(sumTwinShape([cost()], expense())).toBeNull();
    expect(sumTwinShape([cost(), cost({ payer: 'firm', partnerId: FIRM })], expense())).toBeNull();
  });

  it('mixed currencies add in dollars only', () => {
    const summed = sumCosts([cost({ amount: 300, amountUsd: 300 }), cost({ amount: 1440, currency: 'CNY', amountUsd: 200 })]);
    expect(summed.currency).not.toBe('USD');
    expect(summed.amountUsd).toBe(500);
    expect(sumTwinShape([cost({ amount: 300, amountUsd: 300 }), cost({ amount: 1440, currency: 'CNY', amountUsd: 200 })], expense())).toBe(
      'mergeable',
    );
  });
});

describe('the acknowledgement', () => {
  const candidate = { amount: '500.00', currency: 'USD', target: 'x' };

  it('is the same for the same question and different for any other', () => {
    const token = twinAckToken(candidate, ['b', 'a'], []);
    expect(twinAckToken(candidate, ['a', 'b'], [])).toBe(token);
    expect(twinAckToken({ ...candidate, amount: '501.00' }, ['a', 'b'], [])).not.toBe(token);
    expect(twinAckToken(candidate, ['a', 'b', 'c'], [])).not.toBe(token);
    // The second identical bill: the first one is now on the candidate's own book.
    expect(twinAckToken(candidate, ['a', 'b'], ['first'])).not.toBe(token);
  });

  it('warns until the posted token is the one computed now', () => {
    const answer = { lines: [], more: 0, ackToken: 'f'.repeat(64), ids: ['x'], unchecked: false };
    expect(mustWarn(answer, null)).toBe(true);
    expect(mustWarn(answer, 'e'.repeat(64))).toBe(true);
    expect(mustWarn(answer, 'f'.repeat(64))).toBe(false);
    expect(mustWarn({ ...answer, ids: [] }, null)).toBe(false);
    expect(mustWarn(null, null)).toBe(false);
  });

  it('reads only a 64-hex token from a post, and the browser never gets the twin ids', () => {
    expect(twinAckOf({ twinAck: 'a'.repeat(64) })).toBe('a'.repeat(64));
    expect(twinAckOf({ twinAck: 'x'.repeat(64) })).toBeNull();
    expect(twinAckOf({ twinAck: ['a'.repeat(64)] })).toBeNull();
    expect(twinAckOf(null)).toBeNull();
    const view = twinView({ lines: [], more: 0, ackToken: 'f'.repeat(64), ids: ['secret'], unchecked: false });
    expect(view).not.toHaveProperty('ids');
  });
});
