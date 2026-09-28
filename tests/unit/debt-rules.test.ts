import { describe, expect, it } from 'vitest';
import { deferralCover, promiseBrokenAt, promiseVerdict } from '@/modules/wms/debt/rules';

/**
 * The payment promise's verdict and the muddat's share of a release (0114),
 * on LITERAL cases (#1116: a test for a rule anchored on something the rule
 * did not write).
 */

const base = {
  amountUsd: 200,
  paidSinceUsd: 0,
  foreignSince: false,
  balanceUsd: 500,
  dueOn: '2026-10-05',
  now: new Date('2026-10-05T10:00:00Z'),
};

describe('promiseVerdict', () => {
  it('kept when the dollars came, to the cent', () => {
    expect(promiseVerdict({ ...base, paidSinceUsd: 200 })).toBe('kept');
    expect(promiseVerdict({ ...base, paidSinceUsd: 199.995 })).toBe('kept');
    expect(promiseVerdict({ ...base, paidSinceUsd: 199.98 })).toBe('open');
  });

  it('a so‘m payment is judged with the rate-residue allowance (2 % or $5), a dollar one is not', () => {
    expect(promiseVerdict({ ...base, paidSinceUsd: 196, foreignSince: true })).toBe('kept');
    expect(promiseVerdict({ ...base, paidSinceUsd: 194, foreignSince: true })).toBe('open');
    expect(promiseVerdict({ ...base, paidSinceUsd: 196, foreignSince: false })).toBe('open');
    // 2 % of $1000 is $20.
    expect(promiseVerdict({ ...base, amountUsd: 1000, paidSinceUsd: 981, foreignSince: true })).toBe('kept');
    expect(promiseVerdict({ ...base, amountUsd: 1000, paidSinceUsd: 979, foreignSince: true })).toBe('open');
  });

  it('settled — not kept — when the debt went away without the payment', () => {
    expect(promiseVerdict({ ...base, balanceUsd: 0 })).toBe('settled');
    expect(promiseVerdict({ ...base, balanceUsd: 0.009 })).toBe('settled');
    expect(promiseVerdict({ ...base, balanceUsd: 0.02 })).toBe('open');
  });

  it('broken from NOON Tashkent the day after the due date, not a minute earlier', () => {
    // 12:00 in Tashkent is 07:00 UTC.
    expect(promiseBrokenAt('2026-10-05').toISOString()).toBe('2026-10-06T07:00:00.000Z');
    expect(promiseVerdict({ ...base, now: new Date('2026-10-06T06:59:00Z') })).toBe('open');
    expect(promiseVerdict({ ...base, now: new Date('2026-10-06T07:00:00Z') })).toBe('broken');
  });

  it('19:30 UTC on the due date is already the NEXT Tashkent day — still open (R5, #1063)', () => {
    expect(promiseVerdict({ ...base, now: new Date('2026-10-05T19:30:00Z') })).toBe('open');
  });

  it('kept wins over broken: money that came in late still keeps the word', () => {
    expect(promiseVerdict({ ...base, paidSinceUsd: 200, now: new Date('2026-11-01T00:00:00Z') })).toBe('kept');
  });
});

describe('deferralCover — which «muddat» let how much of a release through', () => {
  const deals = [
    { dealId: 'a', code: 'B-1', by: 'S1', owedUsd: 600 },
    { dealId: 'b', code: 'B-2', by: 'S2', owedUsd: 300 },
  ];

  it('a debt over every deferral: each job covers all it owes', () => {
    expect(deferralCover(1000, deals)).toEqual([
      { dealId: 'a', code: 'B-1', by: 'S1', usd: 600 },
      { dealId: 'b', code: 'B-2', by: 'S2', usd: 300 },
    ]);
  });

  it('a debt under the deferrals: the oldest job covers it, the next covers nothing', () => {
    expect(deferralCover(500, deals)).toEqual([{ dealId: 'a', code: 'B-1', by: 'S1', usd: 500 }]);
    expect(deferralCover(700, deals)).toEqual([
      { dealId: 'a', code: 'B-1', by: 'S1', usd: 600 },
      { dealId: 'b', code: 'B-2', by: 'S2', usd: 100 },
    ]);
  });

  it('no debt, an advance or less than a cent: nobody’s muddat released anything', () => {
    expect(deferralCover(0, deals)).toEqual([]);
    expect(deferralCover(-50, deals)).toEqual([]);
    expect(deferralCover(0.005, deals)).toEqual([]);
  });
});
