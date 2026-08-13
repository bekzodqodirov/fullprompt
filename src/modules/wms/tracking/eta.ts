import { estimateTransit, type RouteDef, type TransitEstimate } from './engine';
import { CHECKPOINT_SEGMENTS, routeFor } from './map-data';

/**
 * «Yo'lga chiqgandan keyin necha kunda taxminiy yetib keladi» — the owner's
 * question, and the answer was already written down.
 *
 * `map-data.ts` carries a per-route schedule in HIS OWN numbers — Yiwu to
 * Kashgar 6-7 days, «the truck waits at the Chinese border 1-3 days», Osh to
 * Tashkent a day and a half — and `engine.ts` already turns departure + those
 * ranges into "how much is left". It was built to place a dot on a map, so
 * nothing but the map ever asked it. Nothing new had to be configured, and
 * there is no form for him to fill in: the corridor timings ARE the estimate.
 *
 * This module is the one place that assembles the question, because the truck
 * marker and the customer's cabinet must not answer it differently — the
 * anchoring rule below is subtle enough that a second copy would drift (#513).
 */

export interface ScheduleEstimate {
  route: RouteDef;
  est: TransitEstimate;
}

/**
 * What the schedule says about a departed truck, corrected by the last pin.
 *
 * A manual checkpoint re-anchors the clock — that is how the operator fixes
 * the border wait, which is the one leg no schedule can predict. Returns null
 * when there is no route between these two warehouses or the truck has not
 * left: an estimate with nothing to estimate from is worse than silence.
 */
export function scheduleEstimate(
  originCode: string,
  destCode: string,
  departedAt: Date | null,
  checkpoint: unknown,
  now: Date = new Date(),
): ScheduleEstimate | null {
  const route = routeFor(originCode, destCode);
  if (!route || !departedAt) return null;
  const cp = checkpoint as { key?: string; at?: string } | null;
  const anchorSeg = cp?.key ? CHECKPOINT_SEGMENTS[cp.key] : undefined;
  const anchor =
    anchorSeg && cp?.at
      ? {
          segKey: anchorSeg,
          elapsedInSegHours: (now.getTime() - new Date(cp.at).getTime()) / 3_600_000,
        }
      : null;
  const est = estimateTransit(
    route,
    (now.getTime() - departedAt.getTime()) / 3_600_000,
    anchor,
  );
  return { route, est };
}

export interface EtaWindow {
  fromIso: string;
  toIso: string;
}

/**
 * The remaining hours as two dates a person can read.
 *
 * A RANGE, never one date: the schedule itself is a range, and printing its
 * midpoint as a promise turns an estimate into a commitment the office then
 * has to explain. Null when the schedule is exhausted — a truck that should
 * already have arrived has no honest date left, and «taxminan kecha» is worse
 * than saying nothing while the office finds out.
 */
export function etaWindow(est: TransitEstimate, now: Date = new Date()): EtaWindow | null {
  if (est.overdue) return null;
  const [min, max] = est.remainingHours;
  return {
    fromIso: new Date(now.getTime() + min * 3_600_000).toISOString(),
    toIso: new Date(now.getTime() + max * 3_600_000).toISOString(),
  };
}
