import { addDays, calendarDaysBetween, mondayOf, tashkentDay } from '@/modules/platform/time/tashkent';
import { marginPct } from '../accounting/margin';
// The pure file, not `period.ts`: that one reads a rate from the database, and
// this file must stay importable by anything that only draws.
import { priorPeriodOf, type PriorKind } from '../accounting/prior-period';

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
  /** The Monday of this ISO week — the weekly cash chart's current, partial column. */
  weekStart: string;
  /** Twelve weeks, this one included: `weekStart` − 77 days, always a Monday. */
  w12Start: string;
  /** Thirty Tashkent days with today last (and partial): `today` − 29. */
  d30Start: string;
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
  const weekStart = mondayOf(today);
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
    weekStart,
    w12Start: addDays(weekStart, -77),
    d30Start: addDays(today, -29),
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

/**
 * The Monday of every ISO week the range touches, oldest first — the weekly
 * cash chart's x-axis AND the keys `cashFlowByWeek` answers with, so a week
 * with no money is a column of zeros and never a missing column. The first
 * and last week may be partial: the range clips them, the key stays Monday.
 */
export function weeksBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const last = mondayOf(to);
  for (let week = mondayOf(from); week <= last; week = addDays(week, 7)) out.push(week);
  return out;
}

/**
 * The dashboard's period radio, `?davr=` — a CLOSED set (#514): anything else
 * (absent, `07`, `OY`, garbage) reads as «Bu oy», never as a guess.
 */
export type DashPeriodKey = 'bugun' | '7' | '30' | 'oy' | 'otgan';

/** In the order the radio draws them. */
export const DASH_PERIODS: readonly DashPeriodKey[] = ['bugun', '7', '30', 'oy', 'otgan'];

export interface DashPeriod {
  key: DashPeriodKey;
  /** Inclusive Tashkent days. */
  from: string;
  to: string;
  /**
   * What the period is compared with — `priorPeriodOf`, the P&L page's own
   * rule, because every money figure here links to that page and the page
   * must print the same ▲▼ (#513). `kind` lets the screen print the window as
   * DATES instead of a sentence the calendar makes false (the judge's O1).
   */
  prior: { from: string; to: string; kind: PriorKind };
  /** YYYY-MM when the period IS a calendar month (oy, otgan); the plan meter needs one. */
  month: string | null;
  /** A month that has ended (otgan): the plan meter reads it at pace 1, never «behind». */
  closedMonth: boolean;
  /**
   * The plan meter's calendar: «oy» → today's day of this month; «otgan» →
   * that month's length (pace 1). The day windows carry today's figures only
   * so the shape is total — a plan is monthly and they draw no meter.
   */
  dom: number;
  daysInMonth: number;
}

/**
 * One of the five windows from Tashkent's today (R5). «bugun» is today alone,
 * «7» / «30» end today and include it, «oy» is the month to date, «otgan» the
 * whole previous month.
 */
export function dashPeriod(raw: string | undefined | null, today: string): DashPeriod {
  const key: DashPeriodKey = (DASH_PERIODS as readonly string[]).includes(raw ?? '') ? (raw as DashPeriodKey) : 'oy';
  const w = dashboardWindows(today);
  const period = (from: string, to: string, month: string | null = null) => ({
    key,
    from,
    to,
    prior: priorPeriodOf(from, to),
    month,
    closedMonth: false,
    dom: w.dom,
    daysInMonth: w.daysInMonth,
  });
  switch (key) {
    case 'bugun':
      return period(today, today);
    case '7':
      return period(addDays(today, -6), today);
    case '30':
      return period(w.d30Start, today);
    case 'otgan': {
      const last = monthEnd(w.prevMonth, today);
      const days = Number(last.slice(8, 10));
      return { ...period(w.prevStart, last, w.prevMonth), closedMonth: true, dom: days, daysInMonth: days };
    }
    case 'oy':
      return period(w.monthStart, today, w.month);
  }
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
 * The pace a live month needs from here: the days left INCLUDING today (the
 * 27th of a 30-day month leaves 4 — today still counts) and the amount per
 * day that closes the gap. Null with no positive plan (the meter's own rule)
 * and once the fact has reached the plan — «kuniga $0» is not advice. The
 * caller asks only for a month still running: a closed month has no pace.
 */
export function planPace(
  fact: number,
  plan: number | null | undefined,
  dom: number,
  daysInMonth: number,
): { daysLeft: number; perDay: number } | null {
  if (plan === null || plan === undefined || !(plan > 0) || !Number.isFinite(fact)) return null;
  if (fact >= plan) return null;
  const daysLeft = Math.max(1, daysInMonth - dom + 1);
  return { daysLeft, perDay: Math.round(((plan - fact) / daysLeft) * 100) / 100 };
}

/**
 * A percentage change, or null when there is nothing to compare against. A
 * change against zero is not a percentage, and against a NEGATIVE base (a
 * loss month) the sign of a percentage lies — the caller prints the absolute
 * difference there instead. The ONE delta rule: the dashboard's tiles and the
 * P&L page they open both print it, so «▲ 7.6%» on one is never «▲ 8%» on the
 * other (the judge's O4).
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

/**
 * Clean axis ticks over a range that may go below zero — a loss month on the
 * profit line (the judge's O19; `niceTicks` only knows `[0, max]`). The same
 * step ladder as `niceTicks`, the axis always holds 0 (the line a reader
 * measures profit from), `bottom` ≤ min(0, min) and `top` ≥ max(0, max). With
 * nothing below zero it answers exactly what `niceTicks` would.
 */
export function signedTicks(
  min: number,
  max: number,
  count = 4,
): { ticks: number[]; bottom: number; top: number } {
  const lo = Math.min(0, Number.isFinite(min) ? min : 0);
  const hi = Math.max(0, Number.isFinite(max) ? max : 0);
  if (!(hi - lo > 0)) return { ticks: [0], bottom: 0, top: 1 };
  const raw = (hi - lo) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw) ??
    10 * magnitude;
  // Tick INDICES, so the float error of one division cannot add a whole step
  // (0.30000000000000004 / 0.1 is 3.0000000000000004), and −0 prints as 0.
  const first = Math.floor(lo / step + 1e-9);
  const last = Math.ceil(hi / step - 1e-9);
  const clean = (value: number) => {
    const rounded = Number(value.toPrecision(12));
    return rounded === 0 ? 0 : rounded;
  };
  const ticks: number[] = [];
  for (let i = first; i <= last; i += 1) ticks.push(clean(i * step));
  return { ticks, bottom: clean(first * step), top: clean(last * step) };
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
 * Does this row say anything — a count, or money at stake? The ONE test the
 * ranked list drops empty rows by, exported so a reader that picks a row out
 * of the facts (the owner's Monday summary moves the arrears row into its
 * payments block) asks the list's own question, never a copy of it (#513).
 */
export function attentionLive(item: AttentionItem): boolean {
  return item.count > 0 || (item.usd ?? 0) > 0.009;
}

/**
 * ONE ranked list of what needs a person: bad before warn before info, then
 * the money at stake, then the count. A row with nothing in it is dropped —
 * «0 ta yo'qolgan» is a row nobody reads. `visibleCount` (what the header chip
 * counts) excludes info rows: they are orientation, not work.
 */
export function rankAttention<T extends AttentionItem>(items: T[], visible = 7) {
  const live = items
    .filter(attentionLive)
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
  /**
   * The PART of `revenue` charged to clients whose cargo did not ride (0104,
   * his (a)): Σ `noCargoChargeUsd` over the non-internal rows. Printed beside
   * the revenue on the profit page's JAMI and the dashboard strip, so the two
   * screens say the same sentence.
   */
  noCargo: number;
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
  rows: {
    internal?: boolean;
    revenueUsd: number;
    costUsd: number;
    profitUsd: number | null;
    kg?: number;
    noCargoChargeUsd?: number;
  }[],
): TripTotals {
  let trips = 0;
  let noCargo = 0;
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
    noCargo += row.noCargoChargeUsd ?? 0;
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
    marginPct: marginPct(profit, revenue),
    perKg: pricedKg > 0 ? Math.round((pricedProfit / pricedKg) * 100) / 100 : null,
    losses,
    unpriced,
    internal,
    noCargo: cents(noCargo),
  };
}

/**
 * Whole Tashkent calendar days from `at` to `today` (0 = today). The «stuck
 * truck» rule and the transit chip both count this way, so the attention row
 * and the chip beside the truck can never disagree about the same truck.
 */
export function daysSince(at: Date | string | null | undefined, today: string): number {
  if (!at) return 0;
  return Math.max(0, calendarDaysBetween(tashkentDay(new Date(at)), today));
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

/** One P&L row's figures, the only part `pnlParts` reads: its months and its range total. */
interface PnlRowLike {
  byPeriod: Record<string, number>;
  total: number;
}

/** The five P&L rows the parts are made of. */
interface PnlLike {
  revenue: PnlRowLike;
  directTotal: PnlRowLike;
  opexTotal: PnlRowLike;
  fxTotal: PnlRowLike;
  netProfit: PnlRowLike;
}

/**
 * A P&L period in the chart's parts (0103): the kurs farqi FOLDS into the cost
 * — a gain lowers it, a loss raises it — so revenue − cost = the net the P&L
 * prints, and no screen draws two figures whose difference is not the net
 * under them (the owner judge's finding). The ONE definition of «Xarajat»
 * (the judge's O2): `direct` and `opex` are the P&L page's own KPIs and `fx`
 * its «Kurs farqi» line, so every part the tile prints is a figure on the page
 * it opens (O3).
 *
 * `key` is a month (`YYYY-MM`) or `'total'` — the whole range, which is how a
 * 7- or 30-day window reads: `profitAndLoss` keeps the range total on each
 * row's `.total` (its `byPeriod` holds months only), and the net's total is
 * the P&L's own, never a re-sum of its rounded months.
 */
export function pnlParts(
  pnl: PnlLike,
  key: string,
): { revenue: number; direct: number; opex: number; fx: number; cost: number; net: number } {
  const cents = (value: number) => Math.round(value * 100) / 100;
  const at = (row: PnlRowLike) => (key === 'total' ? row.total : (row.byPeriod[key] ?? 0));
  const revenue = at(pnl.revenue);
  const direct = at(pnl.directTotal);
  const opex = at(pnl.opexTotal);
  const fx = at(pnl.fxTotal);
  return { revenue, direct, opex, fx, cost: cents(direct + opex - fx), net: at(pnl.netProfit) };
}

/** A month's parts — `pnlParts` under the name both P&L charts and the money fence know. */
export function pnlMonthParts(
  pnl: PnlLike,
  month: string,
): { revenue: number; direct: number; opex: number; fx: number; cost: number; net: number } {
  return pnlParts(pnl, month);
}

/** A cash-flow month's parts, the only fields `cashMonthParts` reads. */
interface CashPartsLike {
  clientPayments: number;
  partnerIn: number;
  fxGain: number;
  cargoCosts: number;
  cargoUnrated: number;
  fxLoss: number;
  partnerOut: number;
  clientRefunds: number;
  cashOpex: number;
  net: number;
}

/**
 * A cash-flow month's lines, signed as they move the net (0103): the tooltip
 * prints each, and they add up to the net beside them — the kurs farqi rows
 * and the unrated cargo included, or a month holding one reads a net its
 * lines do not make.
 */
export function cashMonthParts(row: CashPartsLike | undefined): { lines: { key: string; value: number }[]; net: number } {
  const lines = [
    { key: 'clientPayments', value: row?.clientPayments ?? 0 },
    { key: 'partnerIn', value: row?.partnerIn ?? 0 },
    { key: 'fxGain', value: row?.fxGain ?? 0 },
    { key: 'cargoCosts', value: -(row?.cargoCosts ?? 0) },
    { key: 'cargoUnrated', value: -(row?.cargoUnrated ?? 0) },
    { key: 'fxLoss', value: -(row?.fxLoss ?? 0) },
    { key: 'partnerOut', value: -(row?.partnerOut ?? 0) },
    { key: 'clientRefunds', value: -(row?.clientRefunds ?? 0) },
    { key: 'cashOpex', value: -(row?.cashOpex ?? 0) },
  ];
  return { lines, net: row?.net ?? 0 };
}
