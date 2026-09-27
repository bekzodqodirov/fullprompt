import { addDays, calendarDay, dayIn, noonIn } from '../../platform/time/tashkent';

/**
 * The REAL day an office-entered prixod was received (0112, the owner's Q9 b:
 * the logist types the prixod from the warehouse's photos, sometimes a day or
 * three later, and the cargo must still say the day it came).
 *
 * ONE rule for the wizard's date box, the service that refuses and the
 * correction door — the browser imports it too, so it imports nothing but
 * the zone-free clock (`tashkent.ts` is import-free for the same reason).
 *
 * The bound is [entry day − 7, entry day] in the WAREHOUSE's zone:
 *  - the entry day, not the reader's today, so a correction made later can
 *    never widen what was allowed when the prixod was typed;
 *  - the warehouse's zone, because «today» at 23:30 in Tashkent is already
 *    tomorrow in Yiwu, and it is Yiwu's day the cargo came on;
 *  - seven days, because that covers a WhatsApp backlog and a longer gap
 *    would silently rewrite a month somebody has already read.
 *
 * The receipt NUMBER, the box codes and every movement keep the ENTRY clock:
 * they are printed on cartons and compared with money timestamps, and an
 * identifier must not encode a fact a correction can change.
 */
export const RECEIPT_BACKDATE_DAYS = 7;

export type ReceivedDayRefusal = 'received_day_invalid' | 'received_in_future' | 'received_too_old';

/** The earliest and latest day a prixod entered at `entryAt` may claim. */
export function receivedDayBounds(entryAt: Date, timeZone: string): { min: string; max: string } {
  const max = dayIn(entryAt, timeZone);
  return { min: addDays(max, -RECEIPT_BACKDATE_DAYS), max };
}

/**
 * Why `day` cannot be this prixod's day — or null when it can.
 *
 * `calendarDay` round-trips the string, so `2026-02-30` is refused rather
 * than rolled into March (#685's rule). The strings compare as dates because
 * they are all `YYYY-MM-DD`.
 */
export function receivedDayRefusal(
  day: string,
  entryAt: Date,
  timeZone: string,
): ReceivedDayRefusal | null {
  if (!calendarDay(day)) return 'received_day_invalid';
  const { min, max } = receivedDayBounds(entryAt, timeZone);
  if (day > max) return 'received_in_future';
  if (day < min) return 'received_too_old';
  return null;
}

/**
 * The instant to store for `day`: null on the entry day itself (the column
 * keeps its `now()` default, so `received_at` equals `created_at` exactly as
 * on every prixod ever typed on the floor), noon on the warehouse's wall clock
 * for a past day.
 */
export function receivedAtFor(day: string, entryAt: Date, timeZone: string): Date | null {
  return day === receivedDayBounds(entryAt, timeZone).max ? null : noonIn(day, timeZone);
}

/**
 * Was this prixod filed on a day other than the one it was typed? Derived,
 * never stored: both columns default to the same `now()` of one INSERT, so
 * they differ only when somebody said so.
 */
export function isBackdated(receipt: { receivedAt: Date; createdAt: Date }): boolean {
  return receipt.receivedAt.getTime() !== receipt.createdAt.getTime();
}
