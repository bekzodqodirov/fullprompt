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
