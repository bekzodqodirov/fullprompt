import { addDays, mondayOf, tashkentDay, tashkentDayStart } from '../../platform/time/tashkent';

/**
 * The Saturday rating's arithmetic (0134, the owner, 2026-10-20: «har shanba
 * soat 18:00 da hodimlar reytingi … kim necha kub necha kg yuk olib kelgani»)
 * — PURE, every rule a row in `tests/unit/staff-rating.test.ts`.
 */

const HOUR = 3_600_000;

export interface RatingWindow {
  /** The Saturday (Tashkent) the window ENDS on at 18:00 — the post's key. */
  key: string;
  from: Date;
  to: Date;
}

/**
 * The week that ended at the latest Saturday 18:00 in Tashkent at or before
 * `now` — his «4a»: Saturday 18:00 to Saturday 18:00, exactly seven days, so a
 * prixod received on Saturday evening or on Sunday belongs to the NEXT week
 * and none falls between two. Uzbekistan keeps no daylight saving, so a
 * Tashkent day's start plus eighteen hours IS 18:00 there.
 */
export function ratingWindowEnding(now: Date): RatingWindow {
  const today = tashkentDay(now);
  let saturday = addDays(mondayOf(today), 5);
  let end = new Date(tashkentDayStart(saturday).getTime() + 18 * HOUR);
  if (end.getTime() > now.getTime()) {
    saturday = addDays(saturday, -7);
    end = new Date(tashkentDayStart(saturday).getTime() + 18 * HOUR);
  }
  return { key: saturday, from: new Date(end.getTime() - 7 * 24 * HOUR), to: end };
}

/** The window before `w` — for «o'tgan hafta» and each person's ▲▼. */
export function previousWindow(w: RatingWindow): RatingWindow {
  const key = addDays(w.key, -7);
  return { key, from: new Date(w.from.getTime() - 7 * 24 * HOUR), to: w.from };
}

/** The week still running: from the last Saturday 18:00 to now — the screen's «shu hafta». */
export function runningWindow(now: Date): RatingWindow {
  const closed = ratingWindowEnding(now);
  return { key: addDays(closed.key, 7), from: closed.to, to: now };
}

export interface CargoRow {
  userId: string;
  name: string;
  m3: number;
  kg: number;
  receipts: number;
}

export interface Standing extends CargoRow {
  rank: number;
}

/**
 * Ranked by kub (his 5a — the KPI is kub too), then kg, then the name, so two
 * runs over the same cargo always print the same order. People with exactly
 * the same kub and kg share a place; nobody with nothing is ranked at all —
 * the post names only who brought cargo (6a).
 */
export function rankStandings(rows: CargoRow[]): Standing[] {
  const sorted = rows
    .filter((r) => r.m3 > 0 || r.kg > 0)
    .sort((x, y) => y.m3 - x.m3 || y.kg - x.kg || x.name.localeCompare(y.name));
  const out: Standing[] = [];
  sorted.forEach((row, i) => {
    const prev = out[i - 1];
    const rank = prev && prev.m3 === row.m3 && prev.kg === row.kg ? prev.rank : i + 1;
    out.push({ ...row, rank });
  });
  return out;
}

/** What a posted rating row keeps, so streaks and records read what people SAW. */
export interface PostedWeek {
  key: string;
  rows: Standing[];
}

/**
 * Weeks in a row on first place, this week included — read from the POSTED
 * weeks (newest first), and only while they are consecutive Saturdays: a
 * week nobody posted (the bot was down) breaks the run rather than bridging it.
 */
export function firstPlaceStreak(userId: string, thisKey: string, posted: PostedWeek[]): number {
  let streak = 1;
  let expect = addDays(thisKey, -7);
  for (const week of posted) {
    if (week.key === thisKey) continue;
    if (week.key !== expect) break;
    if (!week.rows.some((r) => r.rank === 1 && r.userId === userId)) break;
    streak += 1;
    expect = addDays(expect, -7);
  }
  return streak;
}

/**
 * A personal record: more kub than in any week this person was posted in
 * before — and only after two such weeks, or every first appearance would be
 * «a record».
 */
export function isPersonalRecord(userId: string, m3: number, thisKey: string, posted: PostedWeek[]): boolean {
  const before = posted
    .filter((w) => w.key !== thisKey)
    .flatMap((w) => w.rows.filter((r) => r.userId === userId).map((r) => r.m3));
  if (before.length < 2) return false;
  return m3 > Math.max(...before);
}

/** The month a champion post names: the Tashkent month before `now`'s. */
export function previousMonth(now: Date): string {
  const month = tashkentDay(now).slice(0, 7);
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
