import { addDays, calendarDay, tashkentDayStart } from '../../platform/time/tashkent';

/**
 * The KPI's month is a TASHKENT month (0117, his 5b «dated by its receipt
 * day»): a Yiwu receipt made at 01:00 on the 1st Yiwu time is 22:00 on the
 * last day in Tashkent and belongs to the month before — stated on screen.
 * Pure calendar arithmetic over `YYYY-MM` strings, no clock and no zone
 * library: the bounds are `tashkentDayStart`'s literal +05:00 instants.
 */

export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `value` when it is a real `YYYY-MM`, else null — a URL's `?oy` is a forged post until proven (#514). */
export function calendarMonth(value: string | null | undefined): string | null {
  if (!value || !MONTH.test(value)) return null;
  return calendarDay(`${value}-01`) ? value : null;
}

/** `month` moved by `n` months (negative goes back). */
export function addMonths(month: string, n: number): string {
  const year = Number(month.slice(0, 4));
  const index = year * 12 + (Number(month.slice(5, 7)) - 1) + n;
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}

/** The half-open instants of a Tashkent month: [its 1st 00:00 +05, the next month's 1st 00:00 +05). */
export function monthRange(month: string): { from: Date; to: Date } {
  return { from: tashkentDayStart(`${month}-01`), to: tashkentDayStart(`${addMonths(month, 1)}-01`) };
}

/** Every month from `first` to `last`, both inclusive; empty when `last` comes first. */
export function monthsBetween(first: string, last: string): string[] {
  const out: string[] = [];
  for (let m = first; m <= last; m = addMonths(m, 1)) out.push(m);
  return out;
}

/** The last day of `month`, `YYYY-MM-DD`. */
export function monthEndDay(month: string): string {
  return addDays(`${addMonths(month, 1)}-01`, -1);
}
