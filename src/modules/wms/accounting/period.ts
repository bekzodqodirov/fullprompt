import { rateFor } from '../costing/service';
import { calendarDay, tashkentDay } from '@/modules/platform/time/tashkent';

/**
 * Period handling shared by every accounting screen and export.
 *
 * Default range is the current year to date: an owner opening the P&L wants
 * "how are we doing this year", not an empty form. «Today» is Tashkent's (R5):
 * the UTC date turns five hours after the office's, so from midnight to 05:00
 * on 1 January the default period was still last year's.
 */
export function resolvePeriod(params: { from?: string; to?: string }, now: Date = new Date()) {
  const today = tashkentDay(now);
  // A REAL calendar day or nothing (U43): the bare regex let 2026-02-30 reach
  // postgres, which answered 22008 on every report and export of the period.
  const valid = calendarDay;
  const to = valid(params.to) ?? today;
  const from = valid(params.from) ?? `${to.slice(0, 4)}-01-01`;
  // A backwards range would silently return nothing; swap instead.
  return from <= to ? { from, to } : { from: to, to: from };
}

/**
 * Today's UZS rate, for showing sums in soʻm next to the USD ones (owner's
 * answer 10). Deliberately TODAY's rate and not the rate of each row: this is
 * a convenience conversion for reading, while the USD figures are the ones
 * frozen at entry and the ones the reports actually add up.
 */
export async function uzsRate(): Promise<number | null> {
  const rate = await rateFor('UZS', tashkentDay());
  return rate && rate > 0 ? rate : null;
}

/** USD → UZS at the given rate; null when no rate has been entered yet. */
export function toUzs(amountUsd: number, rate: number | null): number | null {
  if (!rate) return null;
  return Math.round(amountUsd / rate);
}

/**
 * The period a report compares itself with (the P&L's ▲▼, the owner's item
 * 10): the year before for a year-to-date range, the month before for a
 * month-to-date one — both on the SAME days, so a September 1–26 is read
 * against August 1–26 and not against a whole August — and otherwise the
 * equal span immediately before. A day past the prior month's end clamps to
 * it (31 March → 28/29 February).
 */
export function priorPeriod(from: string, to: string): { from: string; to: string } {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const shift = (y: number, m: number, d: number, months: number) => {
    const first = new Date(Date.UTC(y, m - 1 - months, 1));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return iso(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))));
  };
  if (fd === 1 && fm === 1 && fy === ty) return { from: shift(fy, fm, fd, 12), to: shift(ty, tm, td, 12) };
  if (fd === 1 && fy === ty && fm === tm) return { from: shift(fy, fm, fd, 1), to: shift(ty, tm, td, 1) };
  const day = 86_400_000;
  const start = Date.parse(`${from}T00:00:00Z`);
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - start) / day) + 1;
  return { from: iso(new Date(start - span * day)), to: iso(new Date(start - day)) };
}
