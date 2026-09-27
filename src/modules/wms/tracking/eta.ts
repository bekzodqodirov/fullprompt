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
 * The key `routeFor` gives its straight-line fallback's only leg. Every route
 * the owner actually described is built from named legs (cn_transit,
 * to_border, border_wait, kg, uz); this one is what the table answers for a
 * pair it has NO timings for.
 */
const GENERIC_LEG = 'transit';

/**
 * Is this `routeFor`'s straight-line fallback — a pair between two mapped
 * warehouses that nobody wrote a schedule for (TAS1 → AND, YW → GZ, TAS1 →
 * TAS2, anything driven back towards China)?
 *
 * Such a route carries a GENERIC 120-168 hours, which is a placeholder and
 * not anybody's number: it promised a customer «taxminan 5-7 kun» for a
 * shuttle across Tashkent and drew a lorry creeping along a straight line
 * through the Tian Shan at that pace (round B, O14). It is not an estimate,
 * so it must not become a date, a percentage or a dot.
 */
export function isGenericRoute(route: RouteDef): boolean {
  return route.segments.length > 0 && route.segments.every((s) => s.key === GENERIC_LEG);
}

/**
 * What the schedule says about a departed truck, corrected by the last pin.
 *
 * A manual checkpoint re-anchors the clock — that is how the operator fixes
 * the border wait, which is the one leg no schedule can predict. Returns null
 * when there is no route between these two warehouses or the truck has not
 * left: an estimate with nothing to estimate from is worse than silence.
 *
 * A GENERIC route is «no route» for this question (`isGenericRoute`). The
 * refusal lives HERE and not in `etaWindow` because this is the one door
 * every reader walks through: the customer's cabinet (no road bar, no date —
 * the rung alone), the staff map and the cabinet map (`truckFor`: no invented
 * dot; a truck the driver's phone reports is still drawn at its fix), the
 * staff bot (no «~5–7 kun»), and the dashboard's trucks card
 * (`no_schedule`). Refused at `etaWindow`, the map would have kept its
 * made-up dot and its made-up days while the cabinet said nothing.
 */
export function scheduleEstimate(
  originCode: string,
  destCode: string,
  departedAt: Date | null,
  checkpoint: unknown,
  now: Date = new Date(),
): ScheduleEstimate | null {
  const route = routeFor(originCode, destCode);
  if (!route || isGenericRoute(route) || !departedAt) return null;
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
