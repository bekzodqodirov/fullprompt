/**
 * «Today» and «this month» for GSR — the office's day, never the server's.
 *
 * Node and Postgres both run in UTC, and Tashkent is UTC+5, so for the first
 * five hours of every office day `new Date().toISOString().slice(0, 10)`
 * answered YESTERDAY for «today» (owner's answer a, R5): a payment typed at
 * 01:00 on the 1st was filed on the 31st, in last month's P&L and at last
 * month's rate; a bare `::date` bound on a timestamp cut the day at 05:00
 * here, which is the Chinese warehouses' 08:00; and every «this month»
 * counter turned five hours late. This file is the one place that says what
 * today is; everything that asks goes through it.
 *
 * Uzbekistan has not observed daylight saving since 1991, so the offset is a
 * constant and `tashkentDayStart` can write it as a literal `+05:00` — exact,
 * not approximate.
 *
 * ZERO imports on purpose: client components (date inputs' defaults, the
 * ledger form's `max`) import it as well as the services, and a server-only
 * dependency here would drag into the browser bundle.
 */

/** The office's IANA zone — for SQL `AT TIME ZONE` and `Intl` alike. */
export const OFFICE_TZ = 'Asia/Tashkent';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // en-CA prints ISO order (YYYY-MM-DD) — the only locale that does.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/**
 * The calendar day `at` falls on in `timeZone`, as `YYYY-MM-DD`.
 *
 * The general form behind `tashkentDay`, for the few clocks that are
 * deliberately a WAREHOUSE's (a rasxod xabari's spend day, #997) rather than
 * the office's. An unknown zone name falls back to UTC rather than throwing:
 * a mistyped warehouse zone must not white-page the screen that prints it.
 */
export function dayIn(at: Date, timeZone: string): string {
  try {
    return formatterFor(timeZone).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** Today in Tashkent, `YYYY-MM-DD`. */
export function tashkentDay(now: Date = new Date()): string {
  return dayIn(now, OFFICE_TZ);
}

/** This month in Tashkent, `YYYY-MM`. */
export function tashkentMonth(now: Date = new Date()): string {
  return tashkentDay(now).slice(0, 7);
}

/** The first day of this month in Tashkent, `YYYY-MM-01`. */
export function tashkentMonthStart(now: Date = new Date()): string {
  return `${tashkentMonth(now)}-01`;
}

/**
 * The instant a Tashkent calendar day begins — for a `timestamptz` bound.
 * A `date` column compares to the `YYYY-MM-DD` string directly; a timestamp
 * column needs the instant, or the day starts at 05:00 local.
 */
export function tashkentDayStart(day: string): Date {
  return new Date(`${day}T00:00:00+05:00`);
}

/**
 * `YYYY-MM-DD HH:mm` on Tashkent's wall clock — a moment printed into a
 * spreadsheet cell, where a UTC time read as the office's is five hours off.
 * The fixed offset is exact for the reason above.
 */
export function tashkentMinute(at: Date): string {
  return new Date(at.getTime() + 5 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * `day` moved by `n` calendar days (negative goes back). Pure calendar
 * arithmetic at UTC noon, so no zone and no clock can shift the answer.
 */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
