import { estimateTransit, segMid, type BorderPost, type RouteDef, type TransitEstimate } from './engine';
import { CHECKPOINT_KEYS, CHECKPOINT_SEGMENTS, routeFor, type CheckpointKey } from './map-data';

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

const HOUR_MS = 3_600_000;

/**
 * One border queue as the logist typed it on /trucks (0118): the range in
 * hours, and WHEN those hours took effect — the second half is the rule, not
 * metadata. `hours: null` is a reset («Odatdagi jadvalga qaytarish»): his
 * default, counted from that moment like any typed number.
 *
 * `before` is the regime that stood until `sinceMs` (absent = his default),
 * because «had this truck already crossed when the number changed» must be
 * judged against the wait it was actually being given. Judged against the
 * defaults, raising a long queue moved every truck that had stood longer than
 * the DEFAULT midpoint across the border — an earlier date for every customer
 * at the very moment the queue grew (measured: queued 80 h under «4–5 kun»,
 * raised to «5–6 kun» → 86–122 h left instead of 212–276). One level of
 * history: a truck that entered before `before.sinceMs` is judged by the
 * default.
 */
export interface TypedWait {
  hours: readonly [number, number] | null;
  sinceMs: number;
  before?: { hours: readonly [number, number] | null; sinceMs: number };
}

/** Only the posts somebody has typed; an absent post is his default. */
export type BorderHours = Partial<Record<BorderPost, TypedWait>>;

/** A range stretched so its midpoint is `lead` + its own, and its spread is its own. */
function withLead(hours: readonly [number, number], lead: number): [number, number] {
  const mid = segMid(hours);
  // «0–0»: the queue is gone. Whatever the truck already stood there is all
  // it stands.
  if (mid <= 0) return [lead, lead];
  return [(hours[0] * (mid + lead)) / mid, (hours[1] * (mid + lead)) / mid];
}

/**
 * The hours ONE truck stands in a queue it entered at `enters`, under the
 * regime `w` (and, through `w.before`, the one before it).
 *
 * - Entered after the hours took effect: the range, as typed.
 * - Entered before, and — by the wait it was being given then — had crossed
 *   before they changed: that earlier wait stands. A queue changing today
 *   does not move a truck that crossed yesterday, forwards or back.
 * - Entered before and still queueing when they changed: it waits the new
 *   range counted from that moment, `lead` being what it had already stood.
 *
 * `pinned` = the logist's own pin puts the truck IN this queue: positive
 * evidence it has not crossed, so the «had crossed» judgement is skipped —
 * a truck pinned at the border 80 h ago is still at the border when a long
 * queue is typed, and must not be shown furthest ahead for having waited
 * longest.
 */
function queueHours(
  defaults: [number, number],
  w: { hours: readonly [number, number] | null; sinceMs: number; before?: TypedWait['before'] },
  enters: number,
  pinned: boolean,
): [number, number] {
  const current: [number, number] = w.hours ? [w.hours[0], w.hours[1]] : defaults;
  if (enters >= w.sinceMs) return current;
  if (!pinned) {
    const prior = w.before ? queueHours(defaults, w.before, enters, false) : defaults;
    if (enters + segMid(prior) * HOUR_MS <= w.sinceMs) return prior;
  }
  return withLead(current, (w.sinceMs - enters) / HOUR_MS);
}

/**
 * The route with the logist's typed queues in place of the default waits
 * (owner, 2026-09-29, answer 14: «ochered kamaysa tez otb ketadiku»). What
 * the typed number MEANS is printed on the panel beside the inputs: «how long
 * a truck arriving at the queue NOW waits; trucks already queueing are
 * counted from this moment too; trucks that have crossed are unchanged».
 *
 * The schedule is walked from where the clock starts (`from`: the pinned
 * segment at the pin's moment, or the departure), each leg's midpoint after
 * the other — the engine's own arithmetic (`segMid`), so the walk and the dot
 * cannot disagree about where the truck is. At a leg with a typed queue, the
 * moment the schedule puts the truck INTO it decides its hours
 * (`queueHours`).
 *
 * The range is widened with the lead rather than shifted by it, because the
 * engine prices the rest of a leg as `hours × (1 − fraction walked)`: shifted,
 * a truck that had queued 48 h when «12–24» was typed would be told [16, 20]
 * — the right middle with a spread nobody typed. Scaled by (typed mid + lead)
 * ÷ typed mid, the midpoint is still lead + the typed midpoint and the
 * remaining range at the moment of typing is exactly the typed one.
 *
 * Segments before `from.segIdx` are untouched: a later pin wins over any
 * queue behind it. `from.pinned` says the clock starts at a PIN, so the leg
 * at `from.segIdx` is where the logist put the truck. The result is a copy;
 * nothing is mutated.
 */
export function routeWithWaits(
  route: RouteDef,
  from: { segIdx: number; atMs: number; pinned: boolean },
  waits: BorderHours,
): RouteDef {
  let t = from.atMs;
  const segments = route.segments.map((seg, i) => {
    if (i < from.segIdx) return seg;
    const w = seg.post && Object.hasOwn(waits, seg.post) ? waits[seg.post] : undefined;
    const hours = w ? queueHours(seg.hours, w, t, from.pinned && i === from.segIdx) : seg.hours;
    t += segMid(hours) * HOUR_MS;
    return hours === seg.hours ? seg : { ...seg, hours };
  });
  return { points: route.points, segments };
}

/**
 * The pins THIS truck's road can carry, in `CHECKPOINT_KEYS` order — the one
 * question the Mashina tab's buttons are drawn from AND the pin service
 * accepts by (#531: a screen that offers only the right buttons proves
 * nothing about a hand-made post).
 *
 * A pin names a leg (`CHECKPOINT_SEGMENTS`), so a real route offers exactly
 * the keys whose leg it has: Kashgar → Tashkent the border, Kyrgyzstan and
 * Uzbekistan; Horgos → Tashkent the border, Kazakhstan and Uzbekistan; a leg
 * inside China none. A generic route (or none) has no legs to name, and then
 * only «in Uzbekistan» is left, which is also the customer's rung
 * (stages.ts) — offered on a truck bound for anywhere but China.
 */
export function checkpointsFor(
  originCode: string,
  destCode: string,
  destCountry: string | null,
): CheckpointKey[] {
  const route = routeFor(originCode, destCode);
  if (route && !isGenericRoute(route)) {
    return CHECKPOINT_KEYS.filter((key) =>
      route.segments.some((s) => s.key === CHECKPOINT_SEGMENTS[key]),
    );
  }
  return (destCountry ?? '').trim().toUpperCase() === 'CN' ? [] : ['in_uz'];
}

/**
 * The stored pin, if it is one this truck's road can carry — the shape
 * checks the dashboard always made, plus the road. An off-route pin (a
 * «Qirg'izistonda» left on a truck that goes through Kazakhstan, written
 * before this rule existed) is not drawn and anchors nothing; the Mashina tab
 * still offers it for clearing.
 */
export function pinOnRoute(
  raw: unknown,
  originCode: string,
  destCode: string,
  destCountry: string | null,
): { key: CheckpointKey; at: string } | null {
  const cp = raw as { key?: unknown; at?: unknown } | null;
  if (!cp || typeof cp.key !== 'string' || typeof cp.at !== 'string' || !cp.at) return null;
  if (!(CHECKPOINT_KEYS as readonly string[]).includes(cp.key)) return null;
  if (Number.isNaN(new Date(cp.at).getTime())) return null;
  const key = cp.key as CheckpointKey;
  if (!checkpointsFor(originCode, destCode, destCountry).includes(key)) return null;
  return { key, at: cp.at };
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
 *
 * `waits` — the logist's typed border queues (`loadBorderHours`) — is
 * REQUIRED, never defaulted: an optional one fails OPEN, and the day a caller
 * forgets it that caller's date quietly ignores the queue every other screen
 * shows (#790's shape). `{}` is the honest «nothing typed».
 *
 * A pin anchors only when its leg is on THIS route: the engine would ignore
 * an unknown leg anyway, but the queue walk has to start from the same place
 * the engine does, or the two disagree about when the truck reaches a post.
 */
export function scheduleEstimate(
  originCode: string,
  destCode: string,
  departedAt: Date | null,
  checkpoint: unknown,
  waits: BorderHours,
  now: Date = new Date(),
): ScheduleEstimate | null {
  const base = routeFor(originCode, destCode);
  if (!base || isGenericRoute(base) || !departedAt) return null;
  const cp = checkpoint as { key?: unknown; at?: unknown } | null;
  const segKey =
    typeof cp?.key === 'string' && Object.hasOwn(CHECKPOINT_SEGMENTS, cp.key)
      ? CHECKPOINT_SEGMENTS[cp.key as CheckpointKey]
      : undefined;
  const idx = segKey ? base.segments.findIndex((s) => s.key === segKey) : -1;
  const atMs = typeof cp?.at === 'string' ? new Date(cp.at).getTime() : Number.NaN;
  const anchored = idx >= 0 && Number.isFinite(atMs);
  const route = routeWithWaits(
    base,
    anchored
      ? { segIdx: idx, atMs, pinned: true }
      : { segIdx: 0, atMs: departedAt.getTime(), pinned: false },
    waits,
  );
  const est = estimateTransit(
    route,
    (now.getTime() - departedAt.getTime()) / HOUR_MS,
    anchored ? { segKey: segKey!, elapsedInSegHours: (now.getTime() - atMs) / HOUR_MS } : null,
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
