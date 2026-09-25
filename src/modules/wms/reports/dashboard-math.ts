import { addDays, tashkentDay } from '@/modules/platform/time/tashkent';

/**
 * The dashboard's arithmetic, PURE: windows, plan pace, deltas, scale ticks and
 * the attention ranking. No SQL and no report of its own — every figure the
 * dashboard draws comes from the exported function of the report its link
 * opens (#513); this file only decides how to compare and how to lay it out.
 */

export interface DashboardWindows {
  /** Tashkent's today, YYYY-MM-DD. */
  today: string;
  /** YYYY-MM of today. */
  month: string;
  monthStart: string;
  /** Day of the month today is (1-31). */
  dom: number;
  daysInMonth: number;
  prevMonth: string;
  prevStart: string;
  /**
   * The same day last month, CLAMPED to that month's last day: on the 31st of
   * March the comparison runs to the 29th of February in a leap year, not
   * into March. Month-to-date against the whole previous month would make
   * every month look worse than the last until its final day.
   */
  prevSameDay: string;
  /** The first of the month eleven before this one: twelve months, this one included. */
  m12Start: string;
  nextMonthStart: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

function lastDayOf(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one (UTC arithmetic, no zone).
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function shiftMonth(year: number, month: number, by: number): [number, number] {
  const index = year * 12 + (month - 1) + by;
  return [Math.floor(index / 12), (index % 12) + 1];
}

/** Every window the dashboard names, from Tashkent's today (R5). */
export function dashboardWindows(today: string): DashboardWindows {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const dom = Number(today.slice(8, 10));
  const [py, pm] = shiftMonth(year, month, -1);
  const [sy, sm] = shiftMonth(year, month, -11);
  const [ny, nm] = shiftMonth(year, month, 1);
  const prevLast = lastDayOf(py, pm);
  return {
    today,
    month: `${year}-${pad(month)}`,
    monthStart: `${year}-${pad(month)}-01`,
    dom,
    daysInMonth: lastDayOf(year, month),
    prevMonth: `${py}-${pad(pm)}`,
    prevStart: `${py}-${pad(pm)}-01`,
    prevSameDay: `${py}-${pad(pm)}-${pad(Math.min(dom, prevLast))}`,
    m12Start: `${sy}-${pad(sm)}-01`,
    nextMonthStart: `${ny}-${pad(nm)}-01`,
  };
}

/** The last day of a YYYY-MM month, or today when that month is the current one. */
export function monthEnd(month: string, today: string): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const last = `${month}-${pad(lastDayOf(year, m))}`;
  return last > today ? today : last;
}

/** Every calendar day from `from` to `to`, inclusive — for day-level fences in tests. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) out.push(day);
  return out;
}

export interface PlanProgress {
  /** Fact as a share of the plan, in percent (not capped: 130 means 130%). */
  pct: number;
  /** Where the month's calendar is, 0-1: the pace tick on the meter. */
  pace: number;
  /** Behind the calendar's share of the plan — the one urgency the meter carries. */
  behind: boolean;
  /** At or past the whole plan. */
  done: boolean;
}

/**
 * How far a month has got to its plan. Null when there is no plan to compare
 * against — «reja yo'q» is not a $0 plan every month beats — or when the plan
 * is not a positive figure (a planned loss has no meter; it is printed as text).
 */
export function planProgress(
  fact: number,
  plan: number | null | undefined,
  dom: number,
  daysInMonth: number,
): PlanProgress | null {
  if (plan === null || plan === undefined || !(plan > 0)) return null;
  const pace = Math.min(1, Math.max(0, dom / daysInMonth));
  const share = fact / plan;
  return {
    pct: Math.round(share * 1000) / 10,
    pace,
    behind: share < pace,
    done: share >= 1,
  };
}

/**
 * A percentage change, or null when there is nothing to compare against. A
 * change against zero is not a percentage, and against a NEGATIVE base (a
 * loss month) the sign of a percentage lies — the caller prints the absolute
 * difference there instead.
 */
export function pctDelta(current: number, previous: number): number | null {
  if (!(previous > 0)) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/**
 * Clean axis ticks from 0 to at least `max`: 0 / 20K / 40K, never 0 / 17,352.
 * Returns the ticks and the axis top, which is the last tick.
 */
export function niceTicks(max: number, count = 4): { ticks: number[]; top: number } {
  if (!(max > 0)) return { ticks: [0], top: 1 };
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw) ??
    10 * magnitude;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 1000; value += step) ticks.push(Math.round(value * 100) / 100);
  return { ticks, top };
}

export type AttentionLevel = 'bad' | 'warn' | 'info';

export interface AttentionItem<K extends string = string> {
  kind: K;
  level: AttentionLevel;
  /** How many things are in this row (boxes, trucks, clients…). */
  count: number;
  /** The money at stake, when the viewer may see money; ranks within a level. */
  usd?: number | null;
}

const LEVEL_ORDER: Record<AttentionLevel, number> = { bad: 0, warn: 1, info: 2 };

/**
 * ONE ranked list of what needs a person: bad before warn before info, then
 * the money at stake, then the count. A row with nothing in it is dropped —
 * «0 ta yo'qolgan» is a row nobody reads. `visibleCount` (what the header chip
 * counts) excludes info rows: they are orientation, not work.
 */
export function rankAttention<T extends AttentionItem>(items: T[], visible = 7) {
  const live = items
    .filter((item) => item.count > 0 || (item.usd ?? 0) > 0.009)
    .sort(
      (a, b) =>
        LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
        (b.usd ?? 0) - (a.usd ?? 0) ||
        b.count - a.count,
    );
  const counted = live.filter((item) => item.level !== 'info');
  const worst: AttentionLevel | null = counted.some((item) => item.level === 'bad')
    ? 'bad'
    : counted.length > 0
      ? 'warn'
      : null;
  return {
    visible: live.slice(0, visible),
    hidden: live.slice(visible),
    visibleCount: counted.length,
    worst,
  };
}

export type TripKind = 'internal' | 'unpriced' | 'loss' | 'profit';

/**
 * What a truck row IS, before it is drawn. An unpriced truck has profit =
 * −cost in the report's arithmetic, and drawing that as a red loss bar would
 * tell the owner a trip lost money when nobody has typed its price yet — so
 * it is a chip, never a bar.
 */
export function tripKind(row: { internal: boolean; revenueUsd: number; profitUsd: number | null }): TripKind {
  if (row.internal) return 'internal';
  if (!(Math.abs(row.revenueUsd) > 0.009)) return 'unpriced';
  return (row.profitUsd ?? 0) < 0 ? 'loss' : 'profit';
}

export interface TripTotals {
  /** Non-internal trucks in the window. */
  trips: number;
  revenue: number;
  cost: number;
  /** Σ profit with an unpriced truck counted at −cost — the profit page's JAMI. */
  profit: number;
  marginPct: number | null;
  /** Σ profit / Σ kg over PRICED trucks only (an unpriced truck has no per-kg). */
  perKg: number | null;
  losses: number;
  unpriced: number;
  internal: number;
}

/**
 * The truck report's totals, said once for the profit page's JAMI row and the
 * dashboard's strip. An internal leg is a cost row with no profit (R2a) and
 * its cost already rides inside the export truck as «shu reysgacha», so it
 * stays out — summing it would count that money twice. An unpriced truck IS
 * summed, at −cost, exactly as the page does; the separate «Narxsiz N» count
 * is what explains a low total.
 */
export function tripTotals(
  rows: { internal?: boolean; revenueUsd: number; costUsd: number; profitUsd: number | null; kg?: number }[],
): TripTotals {
  let trips = 0;
  let revenue = 0;
  let cost = 0;
  let profit = 0;
  let pricedProfit = 0;
  let pricedKg = 0;
  let losses = 0;
  let unpriced = 0;
  let internal = 0;
  for (const row of rows) {
    const kind = tripKind({ internal: !!row.internal, revenueUsd: row.revenueUsd, profitUsd: row.profitUsd });
    if (kind === 'internal') {
      internal += 1;
      continue;
    }
    trips += 1;
    revenue += row.revenueUsd;
    cost += row.costUsd;
    profit += row.profitUsd ?? 0;
    if (kind === 'unpriced') unpriced += 1;
    else {
      if (kind === 'loss') losses += 1;
      pricedProfit += row.profitUsd ?? 0;
      pricedKg += row.kg ?? 0;
    }
  }
  const cents = (value: number) => Math.round(value * 100) / 100;
  return {
    trips,
    revenue: cents(revenue),
    cost: cents(cost),
    profit: cents(profit),
    marginPct: revenue > 0.009 ? Math.round((profit / revenue) * 1000) / 10 : null,
    perKg: pricedKg > 0 ? Math.round((pricedProfit / pricedKg) * 100) / 100 : null,
    losses,
    unpriced,
    internal,
  };
}

/**
 * Whole Tashkent calendar days from `at` to `today` (0 = today). The «stuck
 * truck» rule and the transit chip both count this way, so the attention row
 * and the chip beside the truck can never disagree about the same truck.
 */
export function daysSince(at: Date | string | null | undefined, today: string): number {
  if (!at) return 0;
  const from = tashkentDay(new Date(at));
  return Math.max(0, daysBetween(from, today).length - 1);
}

export interface ApprovalCounts {
  /** Requests that ask about a DEBT, and the debt they ask about. */
  debt: { n: number; usd: number };
  /** Requests that ask about cargo with no price. */
  price: { n: number };
}

/**
 * The attention list's two approval rows (0104). A request may ask about a
 * debt, about cargo with no price, or both; a price-only request stores a
 * debt of 0, so summing every row's figure still adds nothing false, but
 * COUNTING it as «qarz bilan berishga ruxsat» would — so each sentence counts
 * only the rows that ask its question, and a row asking both is in both.
 */
export function approvalCounts(
  rows: { blockingDebtUsd: number | string; unpricedBoxIds: readonly string[] | null }[],
): ApprovalCounts {
  let n = 0;
  let usd = 0;
  let price = 0;
  for (const row of rows) {
    const debt = Number(row.blockingDebtUsd);
    if (debt > 0.009) {
      n += 1;
      usd += debt;
    }
    if ((row.unpricedBoxIds ?? []).length > 0) price += 1;
  }
  return { debt: { n, usd: Math.round(usd * 100) / 100 }, price: { n: price } };
}
