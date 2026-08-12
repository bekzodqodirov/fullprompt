import { describe, expect, it } from 'vitest';
import { readBoardFilters } from '@/components/list/board-filter';

/**
 * Round 98's filter review found this live on BOTH boards: the date regex
 * admits impossible calendar days, and the value reaches a raw `::date`
 * cast — so `?dan=2026-02-30` was a Postgres 22008 500, not a dropped
 * filter (#514). The round-trip through Date is the calendar check.
 */
describe('board filter dates are calendar dates, not just digit patterns', () => {
  it('keeps a real day', () => {
    expect(readBoardFilters({ dan: '2026-08-12' }).createdFrom).toBe('2026-08-12');
  });

  it('drops an impossible day the regex alone admits', () => {
    expect(readBoardFilters({ dan: '2026-02-30' }).createdFrom).toBeUndefined();
    expect(readBoardFilters({ gacha: '2026-99-99' }).createdTo).toBeUndefined();
  });
});
