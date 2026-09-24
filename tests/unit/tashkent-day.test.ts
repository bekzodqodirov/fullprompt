import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayIn,
  tashkentDay,
  tashkentDayStart,
  tashkentMonth,
  tashkentMonthStart,
} from '@/modules/platform/time/tashkent';

/**
 * R5 (owner's answer a): «today» and «this month» are Tashkent's everywhere.
 * The server runs in UTC, so from midnight to 05:00 in Tashkent (19:00-24:00
 * UTC) the UTC date is still yesterday's — the hours the helper exists for.
 */
describe('tashkent day', () => {
  it('19:30Z on the 30th is already the 1st of the next month in Tashkent', () => {
    const at = new Date('2026-09-30T19:30:00Z');
    expect(tashkentDay(at)).toBe('2026-10-01');
    expect(tashkentMonth(at)).toBe('2026-10');
    expect(tashkentMonthStart(at)).toBe('2026-10-01');
    // …while the UTC reading the old code took is still September.
    expect(at.toISOString().slice(0, 10)).toBe('2026-09-30');
  });

  it('crosses the year the same way', () => {
    const at = new Date('2026-12-31T19:00:00Z');
    expect(tashkentDay(at)).toBe('2027-01-01');
    expect(tashkentMonth(at)).toBe('2027-01');
  });

  it('18:59Z is still the same Tashkent day', () => {
    expect(tashkentDay(new Date('2026-09-30T18:59:59Z'))).toBe('2026-09-30');
  });

  it('a Tashkent day starts at 19:00Z on the UTC day before', () => {
    expect(tashkentDayStart('2026-10-01').toISOString()).toBe('2026-09-30T19:00:00.000Z');
    expect(tashkentDay(tashkentDayStart('2026-10-01'))).toBe('2026-10-01');
    expect(tashkentDay(new Date(tashkentDayStart('2026-10-01').getTime() - 1))).toBe('2026-09-30');
  });

  it('addDays is calendar arithmetic across months, years and leap days', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-09-24', -60)).toBe('2026-07-26');
  });

  it('dayIn answers another zone, and an unknown zone falls back to UTC', () => {
    expect(dayIn(new Date('2026-08-28T16:30:00Z'), 'Asia/Shanghai')).toBe('2026-08-29');
    expect(dayIn(new Date('2026-08-31T18:10:00Z'), 'Mars/Olympus')).toBe('2026-08-31');
  });
});
