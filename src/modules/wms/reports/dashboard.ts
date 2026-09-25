import { cache } from 'react';
import { tashkentDay, tashkentDayStart } from '@/modules/platform/time/tashkent';
import {
  arAging,
  cashFlowByMonth,
  companyBalance,
  pnlGaps,
  profitAndLoss,
  profitByBatch,
  unbatchedMoney,
} from '../accounting/reports';
import { targetsFor } from '../accounting/targets';
import { decidedLeadsByMonth } from '../crm/analytics';
import { openDealsSummary } from '../deals/service';
import { cargoAtRisk, cargoPipeline, intakeByMonth, unbilledArrived } from './business';
import { costMissingBatches, costMissingCount, inTransitBatches, unclaimedSummary, warehouseFill } from './queries';
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

// Money — the owner's and the admin's (his answer 4a).
export const loadBalance = cache(() => companyBalance());
export const loadPnl12 = cache(() => {
  const w = loadWindows();
  return profitAndLoss(w.m12Start, w.today);
});
/** Last month's days 1..today's day — the like-for-like comparison. */
export const loadPnlPrior = cache(() => {
  const w = loadWindows();
  return profitAndLoss(w.prevStart, w.prevSameDay);
});
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
  return unbatchedMoney(w.m12Start, w.today);
});
export const loadGaps = cache(() => {
  const w = loadWindows();
  return pnlGaps(w.m12Start, w.today);
});
export const loadTarget = cache(async () => {
  const w = loadWindows();
  return (await targetsFor([w.month])).get(w.month) ?? null;
});
export const loadUnbilled = cache((scopeKey: string) => unbilledArrived(unkey(scopeKey)));

// Cargo — the page's own door, scoped.
export const loadPipeline = cache((scopeKey: string) => cargoPipeline(unkey(scopeKey)));
export const loadRisk = cache((scopeKey: string) => cargoAtRisk(unkey(scopeKey)));
export const loadTransit = cache((scopeKey: string) => inTransitBatches(unkey(scopeKey)));
export const loadFill = cache((scopeKey: string, staleDays: number) => warehouseFill(unkey(scopeKey), staleDays));
export const loadUnclaimed = cache((scopeKey: string) => unclaimedSummary(unkey(scopeKey)));
export const loadToday = cache((scopeKey: string) => todaySnapshot(unkey(scopeKey)));
export const loadIntake = cache((scopeKey: string) => {
  const w = loadWindows();
  return intakeByMonth(w.m12Start, w.today, unkey(scopeKey), w.dom);
});
export const loadCostMissing = cache(async (scopeKey: string) => {
  const count = await costMissingCount(3);
  return { count, rows: count > 0 ? await costMissingBatches(3, unkey(scopeKey)) : [] };
});

// Sales — by the decision clock.
export const loadOpenDeals = cache(() => openDealsSummary());
/** `ownerId` '' = every seller's (crm.leads.view_all), else the viewer's own. */
export const loadSales = cache((ownerId: string) => salesSnapshot(ownerId || undefined));
export const loadDecided = cache(() => {
  const w = loadWindows();
  return decidedLeadsByMonth(tashkentDayStart(w.m12Start), tashkentDayStart(w.nextMonthStart), w.dom);
});
