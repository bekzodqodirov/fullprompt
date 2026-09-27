import { cache } from 'react';
import { addDays, tashkentDay, tashkentDayStart } from '@/modules/platform/time/tashkent';
import {
  arAging,
  cashFlow,
  cashFlowByMonth,
  cashFlowByWeek,
  companyBalance,
  companyBalanceParts,
  pnlGaps,
  profitAndLoss,
  profitByBatch,
  unbatchedRevenue,
} from '../accounting/reports';
import { targetsFor } from '../accounting/targets';
import { leadArrivals, leadDecisions } from '../crm/analytics';
import { openDealsSummary } from '../deals/service';
import { futureDatedEntries } from '../finance/service';
import { trucksOnRoad } from '../tracking/on-road';
import { cargoAtRisk, cargoPipeline, intakeByDay, unbilledArrived } from './business';
import {
  costMissingBatches,
  costMissingCount,
  receiptsJournalTotals,
  unclaimedSummary,
  warehouseFill,
} from './queries';
import { warehouseOptions } from './report-scope';
import { salesSnapshot, todaySnapshot } from './overview';
import { dashboardWindows } from './dashboard-math';

/**
 * The dashboard's loaders, each wrapped in React `cache()` so the tiles, the
 * charts and the attention list pay for a source ONCE per render (the
 * `getActor` memo's idiom). No loader computes a figure of its own: every one
 * is the exported function of the report its link opens, over the window the
 * link carries (#513) — so when a report is corrected, the dashboard follows.
 *
 * A warehouse scope is passed as a string key because `cache()` compares
 * arguments by identity; `scopeKey` is the joined id list, '' = all.
 */

export const loadWindows = cache(() => dashboardWindows(tashkentDay()));

const unkey = (scopeKey: string) => (scopeKey ? scopeKey.split(',') : undefined);
const NO_WAREHOUSE = '00000000-0000-0000-0000-000000000000';
/**
 * `undefined` = the whole company. An EMPTY list is a scoped viewer with no
 * warehouse, who must read nothing — and the query functions read an empty
 * list as «no filter», so it becomes the nil uuid, which matches no row.
 */
export const scopeKeyOf = (ids: string[] | undefined) =>
  ids === undefined ? '' : ids.length === 0 ? NO_WAREHOUSE : [...ids].sort().join(',');

// Money — the owner's and the admin's (his answer 4a). The full balance waits
// for the Balans line's company-wide unpriced-cargo read (U03); a section that
// prints no net — the hero's cash value, the attention list — reads the parts,
// which the full balance shares through their own `cache`, and does not wait.
export const loadBalance = cache(() => companyBalance());
export const loadBalanceParts = cache(() => companyBalanceParts());
export const loadPnl12 = cache(() => {
  const w = loadWindows();
  return profitAndLoss(w.m12Start, w.today);
});
/**
 * The P&L over the chosen period, and over its comparison window
 * (`priorPeriodOf`) — the SAME call the P&L page makes for the link the tile
 * carries, so the tile's ▲▼ and the page's are one computation (#513).
 */
export const loadPnlRange = cache((from: string, to: string) => profitAndLoss(from, to));
/** Cash in / out over the chosen period — the cash-flow page's own total. */
export const loadCashRange = cache((from: string, to: string) => cashFlow(from, to));
/** Twelve Monday-weeks, this one included (partial), from the cash flow's core. */
export const loadCashWeeks = cache(() => {
  const w = loadWindows();
  return cashFlowByWeek(w.w12Start, w.today);
});
/** Rows dated after today: the receivable counts them, the aging does not (O8). */
export const loadFutureDated = cache(() => futureDatedEntries());
export const loadCashByMonth = cache(() => {
  const w = loadWindows();
  return cashFlowByMonth(w.m12Start, w.today);
});
export const loadAging = cache(() => arAging(loadWindows().today));
export const loadTrips = cache(() => {
  const w = loadWindows();
  return profitByBatch(w.m12Start, w.today);
});
export const loadUnbatched = cache(() => {
  const w = loadWindows();
  return unbatchedRevenue(w.m12Start, w.today);
});
export const loadGaps = cache(() => {
  const w = loadWindows();
  return pnlGaps(w.m12Start, w.today);
});
/** The monthly plan of a YYYY-MM — this month, or last month for «O'tgan oy». */
export const loadTargetFor = cache(async (month: string) => (await targetsFor([month])).get(month) ?? null);
export const loadUnbilled = cache((scopeKey: string) => unbilledArrived(unkey(scopeKey)));

// Cargo — the page's own door, scoped.
export const loadPipeline = cache((scopeKey: string) => cargoPipeline(unkey(scopeKey)));
export const loadRisk = cache((scopeKey: string) => cargoAtRisk(unkey(scopeKey)));
/**
 * The trucks card, the stock tile's count and the attention list's «stuck»
 * row read ONE ranking, so the three cannot count a truck differently.
 */
export const loadTrucks = cache((scopeKey: string) => trucksOnRoad(unkey(scopeKey), { limit: 6 }));
export const loadFill = cache((scopeKey: string, staleDays: number) => warehouseFill(unkey(scopeKey), staleDays));
export const loadUnclaimed = cache((scopeKey: string) => unclaimedSummary(unkey(scopeKey)));
export const loadToday = cache((scopeKey: string) => todaySnapshot(unkey(scopeKey)));
/** Thirty Tashkent days of intake, today (partial) last. */
export const loadIntakeDays = cache((scopeKey: string) => {
  const w = loadWindows();
  return intakeByDay(w.d30Start, w.today, unkey(scopeKey));
});
/** The receipts journal's own header over the chosen period — the tile links there. */
export const loadIntakeRange = cache((scopeKey: string, from: string, to: string) =>
  receiptsJournalTotals({ from, to }, unkey(scopeKey)),
);
/** The warehouse picker's options, over the viewer's BASE scope (never the narrowed one, O9). */
export const loadWarehouseOptions = cache((baseKey: string) => warehouseOptions(unkey(baseKey)));
export const loadCostMissing = cache(async (scopeKey: string) => {
  const count = await costMissingCount(3);
  return { count, rows: count > 0 ? await costMissingBatches(3, unkey(scopeKey)) : [] };
});

// Sales — by the decision clock.
export const loadOpenDeals = cache(() => openDealsSummary());
/** `ownerId` '' = every seller's (crm.leads.view_all), else the viewer's own. */
export const loadSales = cache((ownerId: string) => salesSnapshot(ownerId || undefined));
/**
 * New leads and decisions over the chosen period — the tahlil screen's own
 * functions (`salesAnalytics` calls the same two), so the line and the page it
 * links to cannot disagree. Tashkent midnights, the period's end exclusive.
 */
export const loadLeadFlow = cache(async (from: string, to: string) => {
  const period = { from: tashkentDayStart(from), to: tashkentDayStart(addDays(to, 1)) };
  const [fresh, decided] = await Promise.all([leadArrivals(period), leadDecisions(period)]);
  return { fresh, ...decided };
});
