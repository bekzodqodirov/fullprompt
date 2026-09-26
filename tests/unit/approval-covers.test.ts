import { describe, expect, it } from 'vitest';
import { approvalCovers, type ApprovalSnapshot } from '@/modules/wms/issue/approval-covers';

/**
 * The screen's half of «does this recorded permission answer what the counter
 * asks?» (0104). Its SQL twin is `approvalCoversSql`, and the integration
 * suite runs both over one matrix; this pins the pure rule on its own edges.
 */
const NOW = Date.parse('2026-09-25T12:00:00Z');
const live = (over: Partial<ApprovalSnapshot> = {}): ApprovalSnapshot => ({
  status: 'approved',
  expiresAt: new Date(NOW + 3_600_000),
  blockingDebtUsd: 100,
  unpricedBoxIds: ['a', 'b'],
  ...over,
});

describe('approvalCovers', () => {
  it('covers a debt up to its ceiling, a cent of rounding either way, and not a debt that grew', () => {
    expect(approvalCovers(live(), { debtUsd: 100, boxIds: [] }, NOW)).toBe(true);
    expect(approvalCovers(live(), { debtUsd: 100.009, boxIds: [] }, NOW)).toBe(true);
    expect(approvalCovers(live(), { debtUsd: 100.02, boxIds: [] }, NOW)).toBe(false);
    expect(approvalCovers(live(), { debtUsd: 60, boxIds: [] }, NOW)).toBe(true);
  });

  it('covers only cartons in its snapshot — a subset yes, a superset no', () => {
    expect(approvalCovers(live(), { debtUsd: null, boxIds: ['a'] }, NOW)).toBe(true);
    expect(approvalCovers(live(), { debtUsd: null, boxIds: ['a', 'b'] }, NOW)).toBe(true);
    expect(approvalCovers(live(), { debtUsd: null, boxIds: ['a', 'c'] }, NOW)).toBe(false);
  });

  it('an empty question is covered by any live approval; a price-only approval covers no debt', () => {
    expect(approvalCovers(live(), { debtUsd: null, boxIds: [] }, NOW)).toBe(true);
    expect(approvalCovers(live({ blockingDebtUsd: 0 }), { debtUsd: 40, boxIds: [] }, NOW)).toBe(false);
  });

  it('only a live APPROVED row covers anything', () => {
    expect(approvalCovers(live({ status: 'pending' }), { debtUsd: null, boxIds: [] }, NOW)).toBe(false);
    expect(approvalCovers(live({ status: 'consumed' }), { debtUsd: null, boxIds: [] }, NOW)).toBe(false);
    expect(approvalCovers(live({ expiresAt: new Date(NOW - 1) }), { debtUsd: null, boxIds: [] }, NOW)).toBe(false);
    expect(approvalCovers(live({ expiresAt: null }), { debtUsd: null, boxIds: [] }, NOW)).toBe(false);
    // The screen receives the expiry as the JSON string it was sent as.
    expect(
      approvalCovers(live({ expiresAt: new Date(NOW + 60_000).toISOString() }), { debtUsd: null, boxIds: ['b'] }, NOW),
    ).toBe(true);
  });
});
