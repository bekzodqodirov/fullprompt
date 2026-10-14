import { describe, expect, it } from 'vitest';
import {
  mustWarn,
  storedCents,
  sumCosts,
  sumTwinShape,
  twinAckOf,
  twinAckToken,
  twinCure,
  twinGap,
  twinIsApprox,
  twinShape,
  twinView,
  type TwinCost,
  type TwinExpense,
} from '@/modules/wms/accounting/twins';
import { MERGE_DAYS, sameMoney } from '@/modules/wms/accounting/cost-merge';

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
  merged: false,
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

  it('a kassa-less cost the merge ALREADY joined is cured by a void, never offered the merge that refuses it', () => {
    const joined = cost({ merged: true });
    expect(twinShape(joined, expense({ payer: 'kassa', accountId: KASSA }))).toBe('kassa_cash');
    expect(twinCure(twinShape(joined, expense())!)).toBe('void');
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

describe('the money rule outside one kassa: M4a’s, and between currencies a proportion', () => {
  it('another currency: within 1 % of the expense’s dollars, no $5 floor — the alarm is narrower than the merge', () => {
    const cny = cost({ amount: 3600, currency: 'CNY', amountUsd: 500 });
    expect(twinShape(cny, expense({ amount: 505, amountUsd: 505 }))).toBe('mergeable'); // 5 ≤ 5.05
    // 1 % of the EXPENSE's dollars, as the merge reads its band: 4.95 ≤ 4.9505, 5 > 4.95.
    expect(twinShape(cny, expense({ amount: 495.05, amountUsd: 495.05 }))).toBe('mergeable');
    expect(twinShape(cny, expense({ amount: 495, amountUsd: 495 }))).toBeNull();
    expect(twinShape(cny, expense({ amount: 506, amountUsd: 506 }))).toBeNull(); // 6 > 5.06
    const small = cost({ amount: 1440, currency: 'CNY', amountUsd: 200 });
    expect(twinShape(small, expense({ amount: 201.9, amountUsd: 201.9 }))).toBe('mergeable'); // 1.9 ≤ 2.02
    // The merge would still call these the same money (2 %, or $5 under $250); the alarm does not.
    expect(twinShape(small, expense({ amount: 202.5, amountUsd: 202.5 }))).toBeNull();
    expect(twinShape(small, expense({ amount: 204.9, amountUsd: 204.9 }))).toBeNull();
  });

  it('another currency: within three days — a declaration paid at the same day’s rate, never two weeks apart', () => {
    const customs = cost({ amount: 500, currency: 'USD', amountUsd: 500, costDate: '2026-10-10' });
    const paid = (day: string) => expense({ payer: 'kassa', accountId: KASSA, amount: 6_300_000, currency: 'UZS', amountUsd: 500, expenseDate: day });
    expect(twinShape(customs, paid('2026-10-13'))).toBe('mergeable');
    expect(twinShape(customs, paid('2026-10-07'))).toBe('mergeable');
    expect(twinShape(customs, paid('2026-10-14'))).toBeNull();
    // An un-merge restored it: no day check, as in the merge (#919).
    expect(twinShape(customs, { ...paid('2026-10-20'), restored: true })).toBe('mergeable');
    // One currency keeps the merge's two weeks.
    expect(twinShape(cost({ costDate: '2026-10-10' }), expense({ expenseDate: '2026-10-24' }))).toBe('mergeable');
  });

  it('the review’s pair: a $40 unloading bill and a 470 000 so’m water bill ten days later are two payments', () => {
    const unloading = cost({ amount: 40, amountUsd: 40, costDate: '2026-10-01' });
    const water = expense({ payer: 'kassa', accountId: KASSA, amount: 470_000, currency: 'UZS', amountUsd: 37, expenseDate: '2026-10-11' });
    expect(twinShape(unloading, water)).toBeNull();
    // …and on the same day too: only a $5 floor would call $40 and $37 one payment.
    expect(twinShape(unloading, { ...water, expenseDate: '2026-10-01' })).toBeNull();
    // …while the merge, where a person chooses, still allows it — the alarm is the stricter of the two.
    expect(sameMoney([{ id: '', amount: 40, currency: 'USD', amountUsd: 40, costDate: '2026-10-01' }], water)).toBeNull();
  });

  it('whatever the alarm calls «mergeable», the merge accepts — over a sweep of figures', () => {
    let seen = 0;
    for (let usd = 1; usd <= 2000; usd += 7.37) {
      for (const drift of [-0.03, -0.021, -0.019, -0.005, 0, 0.004, 0.0199, 0.021, 0.05]) {
        const bill = cost({ amount: usd * 7.2, currency: 'CNY', amountUsd: Math.round(usd * 100) / 100 });
        const paid = Math.round(usd * (1 + drift) * 100) / 100;
        const exp = expense({ payer: 'kassa', accountId: KASSA, amount: paid * 12_600, currency: 'UZS', amountUsd: paid });
        if (twinShape(bill, exp) !== 'mergeable') continue;
        seen++;
        expect(
          sameMoney([{ id: '', amount: bill.amount, currency: bill.currency, amountUsd: bill.amountUsd, costDate: bill.costDate }], exp),
        ).toBeNull();
      }
    }
    expect(seen, 're-anchor').toBeGreaterThan(500);
  });

  it('a match found in dollars between two currencies is marked «≈»; one to the cent is not', () => {
    expect(twinIsApprox(cost({ currency: 'CNY' }), expense(), 'mergeable')).toBe(true);
    expect(twinIsApprox(cost(), expense(), 'mergeable')).toBe(false);
    // The drawer's own figure agrees to the cent, whatever the bill's currency.
    expect(twinIsApprox(somKassaCost, somKassaExpense, 'same_kassa')).toBe(false);
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
    const answer = { lines: [], more: 0, ackToken: 'f'.repeat(64), ids: ['x'], unchecked: false, uncheckedOthers: 0 };
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
    const view = twinView({ lines: [], more: 0, ackToken: 'f'.repeat(64), ids: ['secret'], unchecked: false, uncheckedOthers: 0 });
    expect(view).not.toHaveProperty('ids');
  });

  it('a clean save still says what it could not compare (no rate), and says nothing otherwise', () => {
    const base = { lines: [], more: 0, ackToken: 'f'.repeat(64), ids: [], unchecked: false, uncheckedOthers: 0 };
    expect(twinGap(base)).toBeUndefined();
    expect(twinGap(null)).toBeUndefined();
    expect(twinGap({ ...base, unchecked: true })).toEqual({ unchecked: true, uncheckedOthers: 0 });
    expect(twinGap({ ...base, uncheckedOthers: 3 })).toEqual({ unchecked: false, uncheckedOthers: 3 });
  });
});

describe('a typed figure is compared as the column will STORE it', () => {
  it('postgres rounds the decimal text half away from zero — never the binary float', () => {
    expect(storedCents(1.005)).toBe(101); // Math.round(1.005 * 100) is 100
    expect(storedCents(2.675)).toBe(268);
    expect(storedCents(0.125)).toBe(13);
    expect(storedCents(1.0049)).toBe(100);
    expect(storedCents(-1.005)).toBe(-101);
    expect(storedCents(12_345.675)).toBe(1_234_568);
    expect(storedCents(500)).toBe(50_000);
    expect(storedCents(1e-7)).toBe(0);
  });
});
