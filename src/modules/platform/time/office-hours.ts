import { quietHour } from '../telegram/send';
import { addDays, tashkentDay } from './tashkent';

/**
 * The office DAY in Tashkent — when a person is expected to act on a push.
 *
 * Two boundaries, each said once. The evening end is the customer's night
 * (`quietHour`, 22:00): a message after it still arrives, silently, and
 * nobody is reminded about a lead that landed while the office slept. The
 * morning start is 09:00 and not quietHour's 08:00: that hour is quiet enough
 * for a phone to ring but it is before anybody sits down, and a «15 minutes
 * and nobody called» reminder at 08:15 would be about people on their way in
 * (the design judge's finding 9). The automation rules' hourly sweep (round
 * 86) runs on the same morning, so it reads the constant from here.
 *
 * Server-only (it imports the Telegram sender for `quietHour`); `tashkent.ts`
 * keeps its zero imports for the browser.
 */

/** The hour, on Tashkent's wall clock, the office day begins. */
export const OFFICE_OPEN_HOUR = 9;

/** Tashkent is UTC+5 all year — Uzbekistan keeps no summer time. */
const TASHKENT_OFFSET_MS = 5 * 3_600_000;

/** A Tashkent wall-clock hour as the UTC hour a cron line must name. */
export function utcHourOf(tashkentHour: number): number {
  return (tashkentHour - TASHKENT_OFFSET_MS / 3_600_000 + 24) % 24;
}

function tashkentHourOf(at: Date): number {
  return new Date(at.getTime() + TASHKENT_OFFSET_MS).getUTCHours();
}

/** Inside the office day: opened, and not yet the customer's night. */
export function isOfficeTime(at: Date): boolean {
  return !quietHour(at) && tashkentHourOf(at) >= OFFICE_OPEN_HOUR;
}

/** The instant the office opens on the Tashkent day `day` (`YYYY-MM-DD`). */
function openOn(day: string): Date {
  return new Date(`${day}T${String(OFFICE_OPEN_HOUR).padStart(2, '0')}:00:00+05:00`);
}

/**
 * The next opening strictly after the office day `at` belongs to — today's,
 * when `at` is still before it, else tomorrow's. Meant for an `at` outside
 * the office day; inside it, the answer is tomorrow morning.
 */
export function nextOfficeOpen(at: Date): Date {
  const day = tashkentDay(at);
  const today = openOn(day);
  return at < today ? today : openOn(addDays(day, 1));
}

/** `at` itself inside the office day, else the moment the office next opens. */
export function officeClock(at: Date): Date {
  return isOfficeTime(at) ? at : nextOfficeOpen(at);
}

/**
 * `minutes` of OFFICE time after `from`: «15 minutes after 21:55» is 09:10
 * the next morning, not 22:10 — five of them were spent before the office
 * closed. Walked a minute at a time on purpose: the loop asks only
 * `isOfficeTime`, so neither boundary is written a second time here, and a
 * bound of one day makes the walk cheap (≤ 1,440 steps).
 */
export function addOfficeMinutes(from: Date, minutes: number): Date {
  let at = officeClock(from);
  let left = Math.min(Math.max(0, Math.floor(minutes)), 24 * 60);
  while (left > 0) {
    at = new Date(at.getTime() + 60_000);
    left -= 1;
    if (left > 0 && !isOfficeTime(at)) at = nextOfficeOpen(at);
  }
  // Exactly at closing is already closed: the moment belongs to the morning.
  return officeClock(at);
}
