import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DealCargoPaid } from '@/modules/wms/finance/paid-cartons';
import { ReadDeadlineError } from '@/modules/platform/db/no-jit';
import { upsaleStateOf, walkDealsWithin, UPSALE_WALK_CHUNK } from '@/modules/wms/calc/upsale-service';

/**
 * The walk's error rule, BEHAVIOURAL (review nit T1): fence (e) in
 * upsale-fifo-wire reads that the handler names `isBudgetMiss`, which a
 * handler that swallows everything also does. Here the budgeted read itself
 * is replaced, so what reaches the caller is the only thing asserted:
 *
 * - a budget miss — refused before sending (`ReadDeadlineError`) or cancelled
 *   by postgres (57014, bare or wrapped as drizzle wraps it) — leaves ITS
 *   chunk out of `walked`, and such a deal reads `not_computed`, never a
 *   state the walk would have had to invent;
 * - anything else is a bug and propagates out of the walk.
 *
 * `isBudgetMiss` and `ReadDeadlineError` stay the real ones: the predicate is
 * the subject, only the connection is replaced.
 */
const { withoutJit } = vi.hoisted(() => ({ withoutJit: vi.fn() }));
vi.mock('@/modules/platform/db/no-jit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/platform/db/no-jit')>();
  return { ...real, withoutJit };
});

const PAID: DealCargoPaid = {
  cartons: 3,
  uncovered: 0,
  uncoveredElsewhere: 0,
  unpaid: 0,
  ownChargesOwed: 0,
  toOpenUsd: 0,
  olderOwedElsewhere: false,
};

/** A row the ladder hands to the walk: a deal, cargo arrived, fully invoiced. */
const row = {
  payout_at: null,
  entity_type: 'deal',
  due_price_usd: '100',
  cargo_receipts: 1,
  charged_usd: '100',
  compensated_usd: '0',
};

/** Two chunks: one client per chunk, a chunk's worth of deals each. */
const deals = [
  ...Array.from({ length: UPSALE_WALK_CHUNK }, (_, i) => ({ dealId: `a${i}`, clientId: 'client-a' })),
  ...Array.from({ length: 2 }, (_, i) => ({ dealId: `b${i}`, clientId: 'client-b' })),
];
const walkedMap = (ids: string[]) => new Map(ids.map((id) => [id, PAID] as const));
beforeEach(() => {
  withoutJit.mockReset();
});

describe('walkDealsWithin — only a budget miss is soft', () => {
  it('a plain error propagates: a bug is never turned into «not computed»', async () => {
    withoutJit.mockRejectedValueOnce(new Error('column "x" does not exist'));
    await expect(walkDealsWithin(deals, 60_000)).rejects.toThrow('column "x" does not exist');
  });

  it('a unique violation (23505) propagates too — not every postgres code is a budget', async () => {
    withoutJit.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
    await expect(walkDealsWithin(deals, 60_000)).rejects.toThrow('duplicate key');
  });

  const misses: [string, () => unknown][] = [
    ['ReadDeadlineError (refused before sending)', () => new ReadDeadlineError()],
    ['57014 (cancelled by postgres)', () => Object.assign(new Error('canceling statement'), { code: '57014' })],
    [
      '57014 wrapped in the error drizzle throws',
      () => Object.assign(new Error('Failed query'), { cause: { code: '57014' } }),
    ],
  ];

  for (const [name, error] of misses) {
    it(`${name}: that chunk is missed, the next is still walked, and its deals read not_computed`, async () => {
      withoutJit.mockRejectedValueOnce(error()).mockImplementationOnce(async () => walkedMap(['b0', 'b1']));
      const { walked, missed } = await walkDealsWithin(deals, 60_000);

      expect(missed).toBe(UPSALE_WALK_CHUNK);
      expect(withoutJit).toHaveBeenCalledTimes(2);
      expect([...walked.keys()].sort()).toEqual(['b0', 'b1']);
      // The caller's rule: a deal the walk did not return is NOT guessed.
      expect(upsaleStateOf(row, walked.get('a0') ?? null)).toBe('not_computed');
      expect(upsaleStateOf(row, walked.get('b0') ?? null)).toBe('payable');
    });
  }

  it('a spent budget sends nothing and counts every deal missed', async () => {
    const { walked, missed } = await walkDealsWithin(deals, 0);
    expect(withoutJit).not.toHaveBeenCalled();
    expect(walked.size).toBe(0);
    expect(missed).toBe(deals.length);
  });
});
