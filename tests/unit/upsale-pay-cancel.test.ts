import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The pay door's two endings, BEHAVIOURAL (review nits T2 + defect 2): the
 * door walks the paid cargo on its own transaction under a 20 s statement
 * budget, and
 *
 * - a statement cancel (57014) from that transaction reaches the accountant
 *   as `upsale_not_computed` — words, never a digest — and changes nothing,
 *   so the Balans's remembered commissions stay remembered;
 * - any other failure propagates as itself;
 * - a committed payout forgets the remembered commissions, so the next net
 *   walks again.
 *
 * Everything before the transaction (the category setting, its kind, the
 * rate, the till) is answered here; the transaction itself is the double.
 */
const { getSetting, namesMoneyOnNonCash, rateFor } = vi.hoisted(() => ({
  getSetting: vi.fn(),
  namesMoneyOnNonCash: vi.fn(),
  rateFor: vi.fn(),
}));
vi.mock('@/modules/platform/settings/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/settings/service')>()),
  getSetting,
}));
vi.mock('@/modules/wms/accounting/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/accounting/service')>()),
  namesMoneyOnNonCash,
}));
vi.mock('@/modules/wms/costing/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/costing/service')>()),
  rateFor,
}));

import { db } from '@/modules/platform/db/client';
import { CalcError } from '@/modules/wms/calc/service';
import { payUpsale } from '@/modules/wms/calc/upsale-service';
import { forgetUpsaleLiability, rememberedLiability } from '@/modules/wms/calc/liability-memo';

const ctx = { actorId: '00000000-0000-4000-8000-00000000a001' };
const input = { accountId: '00000000-0000-4000-8000-00000000b001', currency: 'USD', expenseDate: '2026-01-15' };
const offers = ['00000000-0000-4000-8000-00000000c001'];

/** The till read: `db.select(…).from(…).where(…)` answers one USD till. */
function tillAnswers() {
  const where = vi.fn(async () => [{ currency: 'USD' }]);
  vi.spyOn(db, 'select').mockReturnValue({ from: () => ({ where }) } as never);
}

/** Primes the Balans's memo and reports whether the next net would walk again. */
async function memoPrimed() {
  await rememberedLiability(async () => 'remembered');
  return async () => {
    const again = vi.fn(async () => 'walked again');
    const value = await rememberedLiability(again);
    return { walkedAgain: again.mock.calls.length === 1, value };
  };
}

beforeEach(() => {
  forgetUpsaleLiability();
  getSetting.mockResolvedValue('00000000-0000-4000-8000-00000000d001');
  namesMoneyOnNonCash.mockResolvedValue(false);
  rateFor.mockResolvedValue(1);
  tillAnswers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('payUpsale — the transaction’s endings', () => {
  it('a statement cancel (57014) is «not computed», in the upsale’s own words', async () => {
    const next = await memoPrimed();
    vi.spyOn(db, 'transaction').mockRejectedValue(
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    );
    const refused = await payUpsale(offers, input, ctx).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(CalcError);
    expect((refused as CalcError).code).toBe('upsale_not_computed');
    // Nothing was paid, so nothing the memo remembers moved.
    expect(await next()).toEqual({ walkedAgain: false, value: 'remembered' });
  });

  it('the cancel wrapped the way drizzle wraps a driver error is the same refusal', async () => {
    vi.spyOn(db, 'transaction').mockRejectedValue(
      Object.assign(new Error('Failed query: SELECT …'), { cause: { code: '57014' } }),
    );
    await expect(payUpsale(offers, input, ctx)).rejects.toMatchObject({ code: 'upsale_not_computed' });
  });

  it('any other failure propagates as itself — a bug is never dressed as a budget', async () => {
    const boom = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    vi.spyOn(db, 'transaction').mockRejectedValue(boom);
    await expect(payUpsale(offers, input, ctx)).rejects.toBe(boom);
  });

  it('a committed payout forgets the remembered commissions: the next net walks again', async () => {
    const next = await memoPrimed();
    const paid = { expenseId: '00000000-0000-4000-8000-00000000e001', paidUsd: 600, count: 1 };
    vi.spyOn(db, 'transaction').mockResolvedValue(paid as never);
    await expect(payUpsale(offers, input, ctx)).resolves.toEqual(paid);
    expect(await next()).toEqual({ walkedAgain: true, value: 'walked again' });
  });
});
