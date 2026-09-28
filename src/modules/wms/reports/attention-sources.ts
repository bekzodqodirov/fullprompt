import { taskPulse } from '../../platform/tasks/analytics';
import { pendingApprovals } from '../issue/approvals';
import { calcQueueCounts } from '../calc/service';
import type { TrucksOnRoad } from '../tracking/on-road';
import {
  loadAging,
  loadBalanceParts,
  loadCostMissing,
  loadGaps,
  loadRisk,
  loadTrips,
  loadTrucks,
  loadUnbatched,
  loadUnbilled,
  loadUnclaimed,
} from './dashboard';
import { unpricedTrips, type AttentionGates, type AttentionSources, type BalanceParts } from './attention';

type Resolved<T> = T | PromiseLike<T>;

/**
 * Every source «E'tibor kerak» reads, ONCE, in one `Promise.all` — through the
 * dashboard's `cache()` loaders, so on the page the other sections pay for the
 * same reads once. Outside a render `cache()` is a plain call-through (react
 * 19: `cache = fn => (...a) => fn(...a)`), so a caller that already reads the
 * Balans parts or the trucks — the evening summary — hands them in as `have`
 * instead of paying twice (judge 7). The trucks' ranking counts over ALL
 * trucks whatever the limit, so any `trucksOnRoad` answer gives the same
 * `stuck`.
 *
 * Every money source waits on the TOKEN: without a `CompanyMoneySight` in the
 * gates, none of them is even called.
 */
export async function readAttentionSources(
  g: AttentionGates,
  scopeKey: string,
  now: Date,
  have: { balance?: Resolved<BalanceParts>; trucks?: Resolved<TrucksOnRoad> } = {},
): Promise<AttentionSources> {
  const money = g.sight !== null;
  const [balance, aging, trips, gaps, unbilled, risk, trucks, unclaimed, costMissing, tasks, approvals, calc] =
    await Promise.all([
      // The cash half only — the list prints no net, so it does not wait for
      // the Balans line's company-wide read (U03).
      money ? (have.balance ?? loadBalanceParts()) : null,
      money ? loadAging() : null,
      money ? loadTrips() : null,
      money ? loadGaps() : null,
      money ? loadUnbilled(scopeKey) : null,
      g.cargo ? loadRisk(scopeKey) : null,
      g.cargo ? (have.trucks ?? loadTrucks(scopeKey)) : null,
      loadUnclaimed(scopeKey),
      g.seesCostMissing ? loadCostMissing(scopeKey) : null,
      g.allWh ? taskPulse(now) : null,
      g.canApprove ? pendingApprovals() : null,
      g.canCalc ? calcQueueCounts() : null,
    ]);
  // The second-stage read, only when the unpriced row has something in it.
  const unbatched = trips && unpricedTrips(trips).length > 0 ? await loadUnbatched() : null;
  return { balance, aging, trips, gaps, unbilled, risk, trucks, unclaimed, costMissing, tasks, approvals, calc, unbatched };
}
