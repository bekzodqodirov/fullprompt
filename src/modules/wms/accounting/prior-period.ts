/**
 * The period a report compares itself with — the P&L's ▲▼ (the owner's item
 * 10) and the dashboard's, which links to it and so must ask the SAME rule
 * (#513). Its own file with ZERO imports because the dashboard's pure
 * arithmetic calls it, and `period.ts` reads a rate from the database: a pure
 * module importing that would drag the pool into anything that draws a tick.
 * `period.ts` re-exports both names, so every screen still asks it there.
 *
 * `kind` says WHICH comparison the window is, so a screen can say so beside
 * the dates instead of guessing a sentence («kechaga», «o'tgan oyga») that the
 * calendar makes false on predictable days (the judge's O1).
 */
export type PriorKind = 'year' | 'wholeMonth' | 'monthToDate' | 'span';

const DAY_MS = 86_400_000;

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The last day of a month, 1-based month, UTC arithmetic (no zone). */
function lastDayOf(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The comparison window, in this order — the ORDER is the rule:
 *
 * 1. `year` — a range from 1 January within one year is a year to date (or
 *    a whole January): the same days a year earlier. First on purpose, so a
 *    January — «Bu oy» on the 27th, a closed January read in February — keeps
 *    the P&L page's year rule (the owner's default, answer 2a).
 * 2. `wholeMonth` — the 1st to the LAST day of one month is a whole month and
 *    is read against the whole month before: September 1–30 against August
 *    1–31, not August 1–30. Without this branch the month-to-date clamp below
 *    silently dropped the 31st of every long month it compared with.
 * 3. `monthToDate` — the 1st to a day of the same month: the same days of the
 *    month before, a day past its end clamped to it (31 March → 28/29
 *    February), so September 1–26 is read against August 1–26 and not
 *    against a whole August.
 * 4. `span` — anything else: the equal span immediately before.
 */
export function priorPeriodOf(from: string, to: string): { from: string; to: string; kind: PriorKind } {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  const shift = (y: number, m: number, d: number, months: number) => {
    const first = new Date(Date.UTC(y, m - 1 - months, 1));
    const last = lastDayOf(first.getUTCFullYear(), first.getUTCMonth() + 1);
    return iso(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))));
  };
  if (fd === 1 && fm === 1 && fy === ty) {
    return { from: shift(fy, fm, fd, 12), to: shift(ty, tm, td, 12), kind: 'year' };
  }
  if (fd === 1 && fy === ty && fm === tm && td === lastDayOf(ty, tm)) {
    const first = new Date(Date.UTC(fy, fm - 2, 1));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
    return { from: iso(first), to: iso(last), kind: 'wholeMonth' };
  }
  if (fd === 1 && fy === ty && fm === tm) {
    return { from: shift(fy, fm, fd, 1), to: shift(ty, tm, td, 1), kind: 'monthToDate' };
  }
  const start = Date.parse(`${from}T00:00:00Z`);
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - start) / DAY_MS) + 1;
  return { from: iso(new Date(start - span * DAY_MS)), to: iso(new Date(start - DAY_MS)), kind: 'span' };
}

/**
 * The window alone — the shape every screen read before `kind` existed, kept
 * so `{ from, to }` comparisons (and their tests) stay exact.
 */
export function priorPeriod(from: string, to: string): { from: string; to: string } {
  const { from: priorFrom, to: priorTo } = priorPeriodOf(from, to);
  return { from: priorFrom, to: priorTo };
}
