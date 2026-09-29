import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { kpiCloseDay, kpiMonthClosed, lastClosedMonth } from '@/modules/wms/staff/kpi-service';
import { RECEIPT_BACKDATE_DAYS } from '@/modules/wms/receipts/received-day';
import { addMonths, monthEndDay, monthRange, monthsBetween, calendarMonth } from '@/modules/wms/staff/month';

/**
 * A month closes on the 8th of the next (0117): the office door may back-date
 * a prixod up to seven days, so September's cargo is not settled until seven
 * days of October have passed. Anchored on the calendar, not on the constant.
 */
describe('the month closes on the 8th', () => {
  it('the back-date window is still seven days (the close is built on it)', () => {
    expect(RECEIPT_BACKDATE_DAYS).toBe(7);
  });

  it('September closes on 8 October, not on the 7th', () => {
    expect(kpiMonthClosed('2026-09', '2026-10-07')).toBe(false);
    expect(kpiMonthClosed('2026-09', '2026-10-08')).toBe(true);
    expect(kpiMonthClosed('2026-09', '2026-09-30')).toBe(false);
  });

  it('December closes on 8 January of the next year', () => {
    expect(kpiMonthClosed('2026-12', '2027-01-07')).toBe(false);
    expect(kpiMonthClosed('2026-12', '2027-01-08')).toBe(true);
  });

  it('the newest closed month', () => {
    expect(lastClosedMonth('2026-10-07')).toBe('2026-08');
    expect(lastClosedMonth('2026-10-08')).toBe('2026-09');
    expect(lastClosedMonth('2027-01-03')).toBe('2026-11');
  });
});

describe('Tashkent months', () => {
  it('bounds are +05:00 instants: a 22:00 UTC receipt on the 31st is the NEXT month', () => {
    const { from, to } = monthRange('2026-09');
    expect(from.toISOString()).toBe('2026-08-31T19:00:00.000Z');
    expect(to.toISOString()).toBe('2026-09-30T19:00:00.000Z');
  });

  it('calendar arithmetic', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2027-01', -1)).toBe('2026-12');
    expect(monthsBetween('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(monthsBetween('2027-02', '2026-11')).toEqual([]);
    expect(monthEndDay('2027-02')).toBe('2027-02-28');
    expect(calendarMonth('2026-13')).toBeNull();
    expect(calendarMonth('2026-09')).toBe('2026-09');
    expect(calendarMonth('x')).toBeNull();
  });
});

describe('the close day the screen prints is the rule’s own', () => {
  it('September closes on 2026-10-08, December on 2027-01-08', () => {
    expect(kpiCloseDay('2026-09')).toBe('2026-10-08');
    expect(kpiCloseDay('2026-12')).toBe('2027-01-08');
  });

  it('/hodimlar asks kpiCloseDay and restates no window of its own (#513)', () => {
    const page = readFileSync('src/app/(protected)/hodimlar/page.tsx', 'utf8');
    expect(page).toContain('kpiCloseDay(month)');
    expect(page).not.toMatch(/addDays\(/);
  });
});
