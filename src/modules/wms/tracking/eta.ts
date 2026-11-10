import {
  chordDeg,
  cumulativeLengths,
  estimateTransit,
  FRESH_MINUTES,
  projectOnRoute,
  segMid,
  snapToRoute,
  type BorderPost,
  type RouteDef,
  type RoutePoint,
  type RouteSegment,
  type TransitEstimate,
} from './engine';
import { CHECKPOINT_KEYS, CHECKPOINT_SEGMENTS, routeFor, yardFor, type CheckpointKey } from './map-data';
import { zoneOfGenericRoad, zoneOfLeg, zoneOfRoute, type RoadZone } from './place';

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
 * A queue the truck does not leave by time alone (the owner, 2026-11-08,
 * answer 1a — docs/XORGOS-NAVBAT.md §2): a stationary leg carrying a post
 * the logist types the wait of (`BORDER_POSTS` — Horgos and Yallama). The
 * walk reaches it at the usual pace and STOPS; only newer evidence on a
 * later leg moves the truck past it — his «Qozog‘istonda» / «O‘zbekistonda»
 * press, or the driver's phone seen beyond the post (4a). Keyed by the POST,
 * like `routeWithWaits`: the Kashgar road's Irkeshtam wait is stationary too,
 * carries no post and nobody types it, so it walks on as it always did.
 */
export function isHeldQueue(seg: { span: readonly [number, number]; post?: BorderPost }): boolean {
  return seg.post !== undefined && seg.span[0] === seg.span[1];
}

/** Does this road hold a truck anywhere (Horgos → Tashkent / Andijan today)? Asked by the pin service. */
/**
 * Is a truck placed on `segKey` BEHIND the leg pin `key` names, on its road?
 * — a newer phone fix overruled that pin (the truck reads at Horgos while
 * «Qozog‘istonda» stands). The pin door asks it before re-stamping a
 * re-pressed «Qozog‘istonda» / «O‘zbekistonda»: only then does the press say
 * something the screen does not already show. Unknown road or leg = false.
 */
export function placedBehindPin(originCode: string, destCode: string, segKey: string | null, key: CheckpointKey): boolean {
  const segments = routeFor(originCode, destCode)?.segments;
  if (!segments || !segKey) return false;
  const at = segments.findIndex((s) => s.key === segKey);
  const pin = segments.findIndex((s) => s.key === CHECKPOINT_SEGMENTS[key]);
  return at >= 0 && pin >= 0 && at < pin;
}

export function roadHolds(originCode: string, destCode: string): boolean {
  return routeFor(originCode, destCode)?.segments.some(isHeldQueue) ?? false;
}

/**
 * «Ko'p oshdi» (his 2a): more than a day past the LONGEST wait the queue was
 * given is late — the card's «Kechikkan» and the logists' one Telegram
 * message (`queue-alert.ts`). Past the longest wait but within the day the
 * truck has no date and says so, in the warn colour, and nothing is sent.
 */
export const QUEUE_LATE_HOURS = 24;

/**
 * A held queue's hours as days a person reads — the /trucks panel's own rule
 * (`asDays`, two decimals at most: «2,5», «1,25», «3»), so the panel and
 * every sentence under it print one figure for one queue.
 */
export function hoursAsDays(hours: number): number {
  return Math.round((hours / 24) * 100) / 100;
}

/** The day of the wait the truck is in: its first 24 hours are «1-kun» (his 5a). Hours, not calendar days. */
export function queueDayNo(stoodHours: number): number {
  return Math.floor(Math.max(0, stoodHours) / 24) + 1;
}

/**
 * How near a HELD post a fix on the road leading to it reads as «in the
 * queue» (`fixAnchor`, `queueSinceFor`). Wider than `QUEUE_RADIUS_DEG`
 * because a held queue is a line of lorries kilometres long, and a phone in
 * its tail read as «driving to the post» restarted the queue's clock on every
 * report (the design's judge): ~12-16 km here. A lorry DRIVING through that
 * last stretch is minutes from the post anyway. The far side is still the
 * next leg.
 */
export const HELD_QUEUE_RADIUS_DEG = 0.15;

/**
 * The wait a held queue gives NOW, as the /trucks panel shows it: the
 * logist's typed hours, or his default (`BORDER_POSTS`) — and from WHEN they
 * count. The panel's own promise is «navbatda turganlar ham shu paytdan
 * boshlab hisoblanadi», so a number typed while the truck is already in the
 * queue is counted from the typing, SHIFTED and never stretched: the range he
 * typed is the range that runs (the judge: `withLead`'s scaling printed
 * «2–4 kun» beside a typed «0,5–1»). A held truck has not crossed by
 * definition, so the «had it crossed before the change» history
 * (`queueHours`' `before`) has nothing to say here.
 */
function givenWait(
  seg: { hours: [number, number]; post?: BorderPost },
  waits: BorderHours,
): { hours: [number, number]; typed: boolean; sinceMs: number | null } {
  const w = seg.post && Object.hasOwn(waits, seg.post) ? waits[seg.post] : undefined;
  if (!w) return { hours: [seg.hours[0], seg.hours[1]], typed: false, sinceMs: null };
  return w.hours
    ? { hours: [w.hours[0], w.hours[1]], typed: true, sinceMs: w.sinceMs }
    : { hours: [seg.hours[0], seg.hours[1]], typed: false, sinceMs: w.sinceMs };
}

/**
 * A truck standing in a held queue (`isHeldQueue`) — what every screen says
 * about it, from ONE walk (`placeTruck`).
 */
export interface QueueHold {
  post: BorderPost;
  /** When it entered (ISO): the walk's arrival, the logist's «Chegarada» press, or the phone at the post (§2.1). */
  enteredAt: string;
  /** Hours stood so far — the «N-kun» of the words (`queueDayNo`). */
  stoodHours: number;
  /**
   * Where the wait is COUNTED from (ISO): the entry, or the typing on /trucks
   * if that came later (the panel's own sentence). `dueBy` = this + `given[1]`.
   * The late warning claims on it (0140): a wait typed after the warning is a
   * new expectation, and when that one runs out the logists are told again.
   */
  countedFrom: string;
  /** The wait as the /trucks panel shows it — typed, or his default (`givenWait`). */
  given: [number, number];
  /** `given` is the logist's typed number, not the default: the words say «kiritilgan» only then. */
  typed: boolean;
  /** When the longest wait given runs out (ISO): entry, or the typing if later, plus `given[1]`. */
  dueBy: string;
  /** The legs after the queue, [min, max] hours — what is left once it is through. */
  afterHours: [number, number];
  /** Past `dueBy`: no date, nobody knows when it leaves. */
  over: boolean;
  /** Past it by `QUEUE_LATE_HOURS`: the «overdue» kind and the one message to the logists. */
  late: boolean;
}

/** Is there a held queue among these legs — the walk across one cannot date anything beyond it. */
function heldAmong(segments: readonly RouteSegment[]): boolean {
  return segments.some((seg) => isHeldQueue(seg));
}

/**
 * The held queue the walk from `anchor` stands in at `nowMs`, and the moment
 * it entered — the first held queue at or after the anchor's own leg, once
 * the walk (the engine's midpoints) has reached it. Null while the truck is
 * still on the way to it, and on a road with none. A queue BEFORE the
 * anchor's leg is behind it: the evidence put the truck past it. The legs
 * walked are moving legs — the first held queue ends the walk.
 */
function heldQueueAt(route: RouteDef, anchor: Anchor, nowMs: number): { q: number; enteredMs: number } | null {
  let t = anchor.legStartMs;
  for (let i = anchor.segIdx; i < route.segments.length; i += 1) {
    const seg = route.segments[i]!;
    if (isHeldQueue(seg)) return t <= nowMs ? { q: i, enteredMs: t } : null;
    t += segMid(seg.hours) * HOUR_MS;
    // `>`, not `>=`: the engine moves a truck onto the next leg the moment
    // its elapsed time EQUALS a leg's midpoint, so a walk exactly at the
    // queue's door is in it.
    if (t > nowMs) return null;
  }
  return null;
}

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
 *
 * The RAW walk: no fix and no hold (`isHeldQueue`). Every screen reads
 * `placeTruck`, which holds a truck in the Horgos and Yallama queues; this
 * one has no production reader and stays the schedule's own arithmetic.
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
  return walkFrom(base, pinAnchor(base, checkpoint) ?? departureAnchor(departedAt), waits, departedAt, now);
}

/**
 * Where a walk starts: a leg and the moment the truck BEGAN it. `pinned` =
 * the evidence puts the truck IN that leg, which `routeWithWaits` reads as
 * «has not crossed» when the leg is a queue.
 */
interface Anchor {
  segIdx: number;
  legStartMs: number;
  pinned: boolean;
  kind: 'departure' | 'pin' | 'fix';
}

/**
 * A fix as a walk's start: where on the road it put the truck (`along`, the
 * snapped point) and the moment that position HOLDS (`atMs`) — the fix's own,
 * or the logist's press when a newer pin re-timed it (`underNewerPin`).
 */
interface FixAnchor extends Anchor {
  along: number;
  snapped: RoutePoint | null;
  atMs: number;
}

const departureAnchor = (departedAt: Date): Anchor => ({
  segIdx: 0,
  legStartMs: departedAt.getTime(),
  pinned: false,
  kind: 'departure',
});

/** The logist's pin as a walk's start: its leg, begun at the press. */
function pinAnchor(route: RouteDef, checkpoint: unknown): Anchor | null {
  const cp = checkpoint as { key?: unknown; at?: unknown } | null;
  const segKey =
    typeof cp?.key === 'string' && Object.hasOwn(CHECKPOINT_SEGMENTS, cp.key)
      ? CHECKPOINT_SEGMENTS[cp.key as CheckpointKey]
      : undefined;
  const idx = segKey ? route.segments.findIndex((s) => s.key === segKey) : -1;
  const atMs = typeof cp?.at === 'string' ? new Date(cp.at).getTime() : Number.NaN;
  return idx >= 0 && Number.isFinite(atMs) ? { segIdx: idx, legStartMs: atMs, pinned: true, kind: 'pin' } : null;
}

/**
 * THE walk: the typed queues counted from where the anchor puts the truck,
 * then the engine from that leg — the one arithmetic every reader's date
 * and % come out of. A departure walks from the start with no anchor, the
 * way the schedule always did.
 */
function walkFrom(
  base: RouteDef,
  anchor: Anchor,
  waits: BorderHours,
  departedAt: Date,
  now: Date,
): ScheduleEstimate {
  const route = routeWithWaits(
    base,
    { segIdx: anchor.segIdx, atMs: anchor.legStartMs, pinned: anchor.pinned },
    waits,
  );
  const est = estimateTransit(
    route,
    (now.getTime() - departedAt.getTime()) / HOUR_MS,
    anchor.kind === 'departure'
      ? null
      : {
          segKey: route.segments[anchor.segIdx]!.key,
          segIndex: anchor.segIdx,
          elapsedInSegHours: (now.getTime() - anchor.legStartMs) / HOUR_MS,
        },
  );
  return { route, est };
}

/**
 * How far off the drawn road a fix may sit and still say WHERE on it the
 * truck is. Wide on purpose and apart from the map's 0.15° drawing snap: the
 * Horgos road is still hand-drawn town chains whose chords run up to 2° off
 * the real road (measured on the stored Yiwu road), and the question here is
 * «which leg, how far along», not «where to paint the dot».
 */
export const PLACE_TOLERANCE_DEG = 2.5;

/**
 * A fix this near a queue's post, on the road LEADING to it, is in the queue
 * (Irkeshtam, Khorgos, Yallama — every stationary leg, typed or not). The far
 * side is the next leg: a truck just past Yallama is in Uzbekistan, and a
 * radius both ways read the first quarter of Yallama → Tashkent as «navbatda
 * with 3-4 days to go».
 */
export const QUEUE_RADIUS_DEG = 0.05;

/**
 * A fix this near the destination's YARD (`yardFor`: where it really
 * stands, else its map dot — TAS2's dot is drawn 85 km off) is at the gate:
 * the truck has arrived by its own phone and waits for the unload scan that
 * makes it «arrived». Nothing is left to drive, so it carries no date and is
 * never «late» on the road (the review: a phone at the Tashkent yard read
 * «muddatdan oshdi — haydovchi bilan bog'laning» within the hour, and
 * overnight); standing there unloaded is judged by the days since it came
 * (`gateSince`), on the arrived truck's own clock (`truckRow`). The FIX'S OWN
 * distance decides, not its projection: a phone past the road's end projects
 * onto it from anywhere within the tolerance (the recheck).
 */
export const GATE_RADIUS_DEG = QUEUE_RADIUS_DEG;

/**
 * The yard a phone is judged «at the gate» against (`yardFor`, else the
 * road's end), or null when there is none — or when the trip STARTS in it:
 * TAS1 and TAS2 stand in one Tashkent yard, so a TAS1 → TAS2 truck would be
 * «at the gate» from the minute it left.
 */
export function gateYard(originCode: string, destCode: string, roadEnd: RoutePoint | null = null): RoutePoint | null {
  const yard = yardFor(destCode) ?? roadEnd;
  if (!yard) return null;
  const from = yardFor(originCode);
  return from && chordDeg(from, yard) <= GATE_RADIUS_DEG ? null : yard;
}

/**
 * The latest a truck can land by its own SLOWEST pace from where an anchor
 * puts it at `atMs`: the rest of a moving leg at its slowest hours for the
 * distance left, the rest of a queue at its longest wait LESS what it has
 * stood (the engine's proportional remainder would read 9 h of a 72 h wait
 * after 42 h stood, and a fresher «still queueing» fix would move the alarm
 * EARLIER — the recheck), then every later leg at its slowest. `route` is the
 * walk's own, typed queues in place.
 */
function slowestArrivalMs(route: RouteDef, anchor: Anchor, atMs: number): number {
  const seg = route.segments[anchor.segIdx]!;
  const stood = Math.max(0, (atMs - anchor.legStartMs) / HOUR_MS);
  const mid = segMid(seg.hours);
  const here =
    seg.span[0] === seg.span[1]
      ? Math.max(0, seg.hours[1] - stood)
      : mid > 0
        ? seg.hours[1] * Math.max(0, 1 - stood / mid)
        : 0;
  const later = route.segments.slice(anchor.segIdx + 1).reduce((sum, s) => sum + s.hours[1], 0);
  return atMs + (here + later) * HOUR_MS;
}

/**
 * The driver's newest fix as the placement reads it (`latestPositions`): its
 * time is `least(recorded_at, received_at)`, so a phone whose clock runs
 * ahead cannot make a fix newer than the moment it reached us.
 */
export interface PlacementFix {
  lat: number;
  lon: number;
  recordedAt: Date;
  /** 'device' — the driver's phone; 'manual' — a position the logist typed. */
  source: string;
  /** When the phone first put it at its yard (`latestPositions`); null = never. REQUIRED: forgotten, a truck in the yard would never read «stuck». */
  gateSince: Date | null;
  /**
   * Since when the phone has had it in each held queue (`queueSinceFor`):
   * its first fix within `HELD_QUEUE_RADIUS_DEG` of the post after a fix
   * anywhere else — the arrival the phone SAW. Absent = not seen, or not
   * asked (a test): the entry then falls back to the walk and the fix.
   */
  queueSince?: Partial<Record<BorderPost, Date>>;
}

export type PlaceSource = 'gps' | 'manual' | 'pin' | 'schedule';

/**
 * Where a truck on the road is — ONE answer for the batch board, the
 * dashboard's trucks card, the truck card, the map, the bot and the
 * customer's cabinet (owner, 2026-10-17, 4a/5a).
 */
export interface TruckPlace {
  /** The place in his four words; null = «Joyi aniq emas». */
  zone: RoadZone | null;
  /** The leg (`map.seg_*`), when one can be named. */
  segKey: string | null;
  /** 0..1 of the road's LENGTH behind the truck; null = nobody can say. */
  progress: number | null;
  /** Null when overdue, when there is no road to walk, and past a held queue's longest wait. */
  remainingHours: [number, number] | null;
  /** The walk from the newest evidence is spent — or a held queue is a day past its longest wait (2a). */
  overdue: boolean;
  /** The newest fix is at the destination's gate (`GATE_RADIUS_DEG`): no date, not overdue. */
  atGate: boolean;
  /** At the gate: since when (ISO) — the first fix at the yard; null otherwise. */
  gateSince: string | null;
  /** What placed it; null = no road, no pin, no fix. */
  source: PlaceSource | null;
  /** When that evidence was taken (ISO); null for the bare schedule. */
  evidenceAt: string | null;
  /** The fix that placed it is within `FRESH_MINUTES` — the map draws the dot AT it. */
  fresh: boolean;
  /** Where to draw the truck (lon/lat); null = nowhere honest. */
  point: RoutePoint | null;
  /** The road walked (typed queues in place); null = no schedule. */
  route: RouteDef | null;
  /** Standing in a held queue (`isHeldQueue`); null anywhere else. */
  queue: QueueHold | null;
}

export interface PlaceInput {
  originCode: string;
  destCode: string;
  originCountry: string | null;
  destCountry: string | null;
  departedAt: Date | null;
  /** The raw `tracking_checkpoint` jsonb — `pinOnRoute` judges it here. */
  checkpoint: unknown;
  /** The newest fix, if any; absent = nobody asked. */
  fix?: PlacementFix | null;
}

const fixSource = (fix: PlacementFix): PlaceSource => (fix.source === 'manual' ? 'manual' : 'gps');

/**
 * The fix as a walk's start, or null when it says nothing about this road: a
 * fix from before the departure (the yard), or one off the road beyond the
 * tolerance (a phone left behind, a detour no leg describes).
 *
 * On a moving leg the truck is at the fix's DISTANCE fraction of it and began
 * it that share of the leg's typical hours earlier. Within the radius of a
 * queue's post, on the leg leading to it, it is IN the queue — entered at the
 * pin's moment if the pin names that queue, else the schedule's own entry if
 * it came before the fix, else the fix's moment, and never before the
 * departure: one fix cannot say how long the truck has stood there, and the
 * remaining wait is priced by the hours from entry (`routeWithWaits`).
 */
function fixAnchor(
  base: RouteDef,
  fix: PlacementFix,
  prior: Anchor,
  waits: BorderHours,
  departedMs: number,
): FixAnchor | null {
  const fixMs = fix.recordedAt.getTime();
  if (!Number.isFinite(fixMs) || fixMs < departedMs) return null;
  const at = { x: fix.lon, y: fix.lat };
  const proj = projectOnRoute(base.points, at);
  if (!proj || proj.offDeg > PLACE_TOLERANCE_DEG) return null;
  const g = base.segments.findIndex((s) => s.span[0] <= proj.chord && proj.chord < s.span[1]);
  if (g < 0) return null;
  const cum = cumulativeLengths(base.points);
  const snapped = snapToRoute(base.points, at);

  const queue = base.segments[g + 1];
  const held = queue ? isHeldQueue(queue) : false;
  const radius = held ? HELD_QUEUE_RADIUS_DEG : QUEUE_RADIUS_DEG;
  if (queue && queue.span[0] === queue.span[1] && chordDeg(at, base.points[queue.span[0]]!) <= radius) {
    const q = g + 1;
    // The walk dates the entry only when nothing held lies between: a walk
    // across Horgos counts its typical wait as spent, which the hold says it
    // never is — and put a phone first seen at Yallama 96 h into a queue it
    // had just reached (the design's judge, its blocker).
    const walkable = prior.segIdx < q && !heldAmong(base.segments.slice(prior.segIdx, q));
    let entry: number | null = null;
    if (prior.segIdx === q) entry = prior.legStartMs;
    else if (walkable) {
      const walked = routeWithWaits(
        base,
        { segIdx: prior.segIdx, atMs: prior.legStartMs, pinned: prior.pinned },
        waits,
      );
      entry = prior.legStartMs;
      for (let i = prior.segIdx; i < q; i += 1) entry += segMid(walked.segments[i]!.hours) * HOUR_MS;
    }
    // In a held queue the phone that SAW the truck arrive says since when it
    // has stood there (`queueSinceFor` — the driver's phone is the truth, his
    // 4a): over the walk, which only guesses the arrival. A «Chegarada» press
    // keeps its own moment (§2.1).
    const since = held && prior.segIdx !== q ? fix.queueSince?.[queue.post!]?.getTime() : undefined;
    if (since !== undefined && Number.isFinite(since)) entry = since;
    // A pin AHEAD of the queue the phone still sees the truck in — «Qozog‘istonda»
    // pressed on the driver's word before it crossed — dates nothing; with no
    // arrival the phone saw (a HOR truck's yard is inside the post's radius,
    // so at Horgos it never has one), the entry would be the NEWEST fix and
    // restart on every report: never late, never warned (the review). When
    // the departure reaches this queue across nothing held, its walk is the
    // entry, as for a truck with no pin at all.
    if (entry === null && held && prior.segIdx > q && !heldAmong(base.segments.slice(0, q))) {
      const walked = routeWithWaits(base, { segIdx: 0, atMs: departedMs, pinned: false }, waits);
      entry = departedMs;
      for (let i = 0; i < q; i += 1) entry += segMid(walked.segments[i]!.hours) * HOUR_MS;
    }
    let entered = Math.max(departedMs, Math.min(fixMs, entry ?? fixMs));
    // The fix says the truck is STILL in the queue at its own moment. An
    // entry whose walk has it out of the queue by then is disproved by the fix
    // itself — the queue lasted longer than its typical hours, or the truck
    // reached it late and the walk counted the lateness as waiting — so the
    // remaining wait is counted from the fix, the rule `routeWithWaits` uses
    // for a regime that changed mid-queue (the review: a truck 60 h into a
    // 1-3 day Irkeshtam queue, phoning from the post, read «Qirg'izistonda»
    // with a date two days early). One fix cannot say how long it has stood.
    //
    // NOT in a held queue (`isHeldQueue`, his 1a): there the walk never leaves
    // by time, so a fix that still sees the truck at the post disproves
    // nothing — and counting from the fix would restart the queue's clock on
    // every report, so a truck phoning from Horgos could never be late.
    const stands = routeWithWaits(base, { segIdx: q, atMs: entered, pinned: true }, waits).segments[q]!.hours;
    if (!held && entered + segMid(stands) * HOUR_MS <= fixMs) entered = fixMs;
    return {
      segIdx: q,
      legStartMs: entered,
      pinned: true,
      kind: 'fix',
      along: cum[queue.span[0]]!,
      snapped,
      atMs: fixMs,
    };
  }

  const seg = base.segments[g]!;
  const legLen = cum[seg.span[1]]! - cum[seg.span[0]]!;
  const frac = legLen > 0 ? Math.min(1, Math.max(0, (proj.along - cum[seg.span[0]]!) / legLen)) : 0;
  return {
    segIdx: g,
    legStartMs: fixMs - frac * segMid(seg.hours) * HOUR_MS,
    pinned: false,
    kind: 'fix',
    along: proj.along,
    snapped,
    atMs: fixMs,
  };
}

/**
 * Where the truck is: the schedule walked from the NEWEST evidence — the
 * departure, the logist's pin, or the driver's fix (docs/PARTIYA-DOSKASI.md
 * §2). One mechanism, the pin's: a fix anchors the walk exactly as a pin
 * does, at its own point instead of a leg's start, so a stale fix keeps the
 * truck where it was last seen and walking — it never jumps back to the
 * departure schedule because a phone went quiet.
 *
 * The newest evidence wins. A pin newer than the fix that names the fix's own
 * leg keeps the fix's position while the two agree (`underNewerPin`): a
 * coarse «in Kazakhstan» must not drag a truck back to the start of
 * Kazakhstan. A fix at the destination's gate is the truck arrived in all but
 * the scan (`atGate`); a walk from a fix is spent only at its slowest pace and
 * one reporting window after it. A walk that reaches a held queue (Horgos,
 * Yallama — `isHeldQueue`) stops there until newer evidence on a later leg
 * (docs/XORGOS-NAVBAT.md): it can never be «spent» before it is through.
 *
 * `waits` is REQUIRED for the reason `scheduleEstimate` states, and in second
 * place so the wire fence can read it.
 */
export function placeTruck(input: PlaceInput, waits: BorderHours, now: Date = new Date()): TruckPlace {
  const pin = pinOnRoute(input.checkpoint, input.originCode, input.destCode, input.destCountry);
  const fix = input.fix ?? null;
  const base = routeFor(input.originCode, input.destCode);

  // No road to walk — an unmapped pair, a generic straight line, a truck with
  // no departure stamp. Still somewhere when its two ends say so, or when the
  // logist pinned it (a generic road offers only «in Uzbekistan»).
  if (!base || isGenericRoute(base) || !input.departedAt) {
    const pinLeg = pin ? CHECKPOINT_SEGMENTS[pin.key] : null;
    const fixMs = fix?.recordedAt.getTime() ?? Number.NaN;
    const byFix = fix !== null && Number.isFinite(fixMs) && (!pin || fixMs >= new Date(pin.at).getTime());
    // A road nobody modelled still has a yard: the phone there is at the
    // gate on these roads too (TAS1 → AND read «yo'lda» for ever otherwise).
    // A pin pressed after the fix outranks it only where it says something
    // else: «in Uzbekistan» — the one pin a generic road offers — pressed at
    // an Uzbek yard agrees with it, and took a truck out of «stuck» (the
    // fifth recheck); the mapped road keeps it the same way (`underNewerPin`).
    const yard = gateYard(input.originCode, input.destCode);
    const departed = input.departedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const pinAgrees = !pin || byFix || (pin.key === 'in_uz' && input.destCountry === 'UZ');
    if (
      fix !== null &&
      Number.isFinite(fixMs) &&
      pinAgrees &&
      yard &&
      fixMs >= departed &&
      chordDeg({ x: fix.lon, y: fix.lat }, yard) <= GATE_RADIUS_DEG
    ) {
      return {
        zone: base && !isGenericRoute(base) ? zoneOfRoute(base) : zoneOfGenericRoad(input.originCountry, input.destCountry),
        segKey: null,
        progress: null,
        remainingHours: null,
        overdue: false,
        atGate: true,
        gateSince: (fix.gateSince ?? fix.recordedAt).toISOString(),
        source: fixSource(fix),
        evidenceAt: fix.recordedAt.toISOString(),
        fresh: now.getTime() - fixMs <= FRESH_MINUTES * 60_000,
        point: { x: fix.lon, y: fix.lat },
        route: null,
        queue: null,
      };
    }
    return {
      zone: pinLeg
        ? zoneOfLeg(pinLeg)
        : base && !isGenericRoute(base)
          ? zoneOfRoute(base)
          : zoneOfGenericRoad(input.originCountry, input.destCountry),
      segKey: pinLeg,
      progress: null,
      remainingHours: null,
      overdue: false,
      atGate: false,
      gateSince: null,
      source: byFix ? fixSource(fix) : pin ? 'pin' : null,
      evidenceAt: byFix ? fix.recordedAt.toISOString() : (pin?.at ?? null),
      fresh: byFix && now.getTime() - fixMs <= FRESH_MINUTES * 60_000,
      point: fix ? { x: fix.lon, y: fix.lat } : null,
      route: null,
      queue: null,
    };
  }

  const departedMs = input.departedAt.getTime();
  const pinned = pinAnchor(base, pin);
  const prior = pinned ?? departureAnchor(input.departedAt);
  const fixed = fix ? fixAnchor(base, fix, prior, waits, departedMs) : null;
  const fixMs = fix?.recordedAt.getTime() ?? Number.NaN;
  const byFix =
    fixed && pinned && fixMs < pinned.legStartMs
      ? underNewerPin(base, fixed, fixMs, pinned, waits, input.departedAt)
      : fixed;
  const anchor: Anchor & Partial<Omit<FixAnchor, keyof Anchor>> = byFix ?? prior;

  const { route, est } = walkFrom(base, anchor, waits, input.departedAt, now);
  const cum = cumulativeLengths(base.points);
  const total = cum[cum.length - 1] ?? 0;
  const share = (along: number) => (total > 0 ? Math.min(1, Math.max(0, along / total)) : null);
  const fresh = anchor.kind === 'fix' && now.getTime() - fixMs <= FRESH_MINUTES * 60_000;
  const source: PlaceSource =
    anchor.kind === 'fix' ? fixSource(fix!) : anchor.kind === 'pin' ? 'pin' : 'schedule';
  const evidenceAt =
    anchor.kind === 'fix' ? fix!.recordedAt.toISOString() : anchor.kind === 'pin' ? (pin?.at ?? null) : null;
  const fixPoint = anchor.kind === 'fix' ? (anchor.snapped ?? { x: fix!.lon, y: fix!.lat }) : null;
  const placed = (e: TransitEstimate, point: RoutePoint): TruckPlace => ({
    zone: zoneOfLeg(e.segKey),
    segKey: e.segKey,
    progress: e.progress,
    remainingHours: e.remainingHours,
    overdue: false,
    atGate: false,
    gateSince: null,
    source,
    evidenceAt,
    fresh,
    point,
    route,
    queue: null,
  });

  // The slowest arrival from a fix, ONE figure for the due window and for
  // the end of the date while the walk runs (it must not drop below the
  // deadline and then jump back when the walk turns due — the recheck).
  const latestMs = anchor.kind === 'fix' ? slowestArrivalMs(route, anchor, anchor.atMs!) : null;

  const yard = gateYard(input.originCode, input.destCode, base.points[base.points.length - 1]!);
  if (anchor.kind === 'fix' && yard && chordDeg({ x: fix!.lon, y: fix!.lat }, yard) <= GATE_RADIUS_DEG) {
    // At the destination's gate by the phone: arrived in all but the scan.
    // Never «late» here — whether it stands too long is the days since it
    // came, on the arrived truck's clock (`truckRow`): a schedule-based
    // clock flagged a truck the minute it pulled in, or never, or restarted
    // on a pin pressed at the yard (the third recheck).
    const leg = base.segments[base.segments.length - 1]!;
    return {
      zone: zoneOfLeg(leg.key),
      segKey: leg.key,
      progress: 1,
      remainingHours: null,
      overdue: false,
      atGate: true,
      gateSince: (fix!.gateSince ?? fix!.recordedAt).toISOString(),
      source,
      evidenceAt,
      fresh,
      point: { x: fix!.lon, y: fix!.lat },
      route,
      queue: null,
    };
  }

  const held = heldQueueAt(route, anchor, now.getTime());
  if (held) {
    // In a held queue (his 1a): the truck stays at the post however long the
    // wait runs, until newer evidence on a later leg — the logist's press, or
    // the phone beyond the post — makes that leg the anchor. The wait runs
    // from the entry, or from the typing when the logist typed it while the
    // truck was already queueing (`givenWait`); what is left is that window
    // LESS the time gone (`slowestArrivalMs`'s own queue rule — the engine's
    // proportional remainder read 9 h of a 72 h wait after 42 h stood), then
    // every later leg at the wait it gives NOW. Past the window nobody knows
    // when it leaves, so there is no date (`placeDated`); a day past it the
    // truck is late (2a). The dot is the post, or the phone's own fix while
    // that is fresh — a phone in the queue's tail is where the lorry is.
    const nowMs = now.getTime();
    const seg = base.segments[held.q]!;
    const wait = givenWait(seg, waits);
    const from = Math.max(held.enteredMs, wait.sinceMs ?? held.enteredMs);
    const opensMs = from + wait.hours[0] * HOUR_MS;
    const dueMs = from + wait.hours[1] * HOUR_MS;
    const later = base.segments.slice(held.q + 1).map((s) => (isHeldQueue(s) ? givenWait(s, waits).hours : s.hours));
    const afterHours: [number, number] = [
      later.reduce((sum, h) => sum + h[0], 0),
      later.reduce((sum, h) => sum + h[1], 0),
    ];
    const over = nowMs > dueMs;
    const late = nowMs > dueMs + QUEUE_LATE_HOURS * HOUR_MS;
    const hoursTo = (ms: number) => Math.max(0, (ms - nowMs) / HOUR_MS);
    // No `slowestArrivalMs` here: its queue rule is this window, but priced
    // on the walk's route, whose queue a wait typed mid-queue STRETCHES
    // (`withLead`) where the panel shifts it — so a phone's report moved the
    // date a day later and the date then vanished at `dueBy`, before the end
    // it promised (the review). What it added before the queue is the
    // slowest rest of the few kilometres to the post.
    return {
      zone: zoneOfLeg(seg.key),
      segKey: seg.key,
      progress: share(cum[seg.span[0]]!),
      remainingHours: over
        ? null
        : [
            Math.round(hoursTo(opensMs) + afterHours[0]),
            Math.round(hoursTo(dueMs) + afterHours[1]),
          ],
      overdue: late,
      atGate: false,
      gateSince: null,
      source,
      evidenceAt,
      fresh,
      point: fresh && fixPoint ? fixPoint : base.points[seg.span[0]]!,
      route,
      queue: {
        post: seg.post!,
        enteredAt: new Date(held.enteredMs).toISOString(),
        countedFrom: new Date(from).toISOString(),
        stoodHours: Math.max(0, (nowMs - held.enteredMs) / HOUR_MS),
        given: wait.hours,
        typed: wait.typed,
        dueBy: new Date(dueMs).toISOString(),
        afterHours,
        over,
        late,
      },
    };
  }

  if (est.overdue && latestMs !== null) {
    // The walk from the fix ran out at the leg's TYPICAL pace — and a fix
    // says where the truck was, not how fast it goes. It is late only once
    // its own SLOWEST pace from that point is spent too, and one reporting
    // window after it (`FRESH_MINUTES`: the phone reports every 2-3 h by
    // design, so a truck 12 km out is not «call the driver» half an hour
    // later). Until then it is due: by its pace at or near the gate, the
    // window closing on the slowest arrival. The deadline is walked from the
    // fix alone — a queue the phone has seen the truck past cannot move it,
    // nor can a wait the logist types for that queue later (the fixes'
    // review: a first version held such a truck «on time, today» for the
    // whole DEPARTURE schedule, which still counted the queues behind it).
    if (now.getTime() <= latestMs + FRESH_MINUTES * 60_000) {
      const left = Math.max(0, Math.round((latestMs - now.getTime()) / HOUR_MS));
      return placed(
        { ...est, overdue: false, remainingHours: [0, left] },
        fresh && fixPoint ? fixPoint : { x: est.x, y: est.y },
      );
    }
  }

  if (est.overdue) {
    // The walk ran out: no date. The truck is where its newest evidence last
    // put it — a fix's point, a pin's leg. With nothing but the departure the
    // place is the road's one place if the road has only one, and the POINT
    // is nowhere: the spent walk ends on the destination warehouse, and a
    // lorry drawn there reads «arrived» to the customer (the review).
    const leg = anchor.kind === 'departure' ? null : base.segments[anchor.segIdx]!;
    return {
      zone: leg ? zoneOfLeg(leg.key) : zoneOfRoute(base),
      segKey: leg?.key ?? null,
      progress:
        anchor.kind === 'fix' ? share(anchor.along!) : leg ? share(cum[leg.span[0]]!) : null,
      remainingHours: null,
      overdue: true,
      atGate: false,
      gateSince: null,
      source,
      evidenceAt,
      fresh,
      point: fixPoint ?? (leg ? base.points[leg.span[0]]! : null),
      route,
      queue: null,
    };
  }

  // From a fix the window closes on its slowest arrival, never earlier.
  const window: [number, number] =
    latestMs === null
      ? est.remainingHours
      : [est.remainingHours[0], Math.max(est.remainingHours[1], Math.round((latestMs - now.getTime()) / HOUR_MS))];
  return placed({ ...est, remainingHours: window }, fresh && fixPoint ? fixPoint : { x: est.x, y: est.y });
}

/**
 * An older fix under a NEWER pin. The pin is the newest evidence; the fix
 * keeps its finer position only while the two agree — while the walk from the
 * fix still stands on the pin's leg at the moment of the press («in
 * Kazakhstan» must not drag a truck back to the start of Kazakhstan). When the
 * walk from the fix has left that leg by the press, the press disproves the
 * walk (the review: a phone silent 100 h in the Irkeshtam queue, the logist
 * presses «Chegarada», and the card read «O'zbekistonda»):
 * - on a MOVING leg the fix keeps its share of the leg, counted from the
 *   press — the truck was at least where the phone last saw it when the
 *   logist said it was still on that leg;
 * - in a QUEUE the pin's own anchor stands: the queue lasted longer than the
 *   walk said, and its remaining wait is counted from the press (`fixAnchor`'s
 *   rule for a disproved entry).
 * A fix on another leg than the pin's is outranked by the pin, as before.
 */
function underNewerPin(
  base: RouteDef,
  fixed: FixAnchor,
  fixMs: number,
  pinned: Anchor,
  waits: BorderHours,
  departedAt: Date,
): FixAnchor | null {
  if (fixed.segIdx !== pinned.segIdx) return null;
  // A held queue (`isHeldQueue`): «Chegarada» is the logist's «count the
  // queue from now» (docs/XORGOS-NAVBAT.md §2.1) — the meaning a pin has
  // always had, and his way to restart the clock after phoning the driver.
  // The fix's earlier entry would quietly overrule the press he just made.
  if (isHeldQueue(base.segments[pinned.segIdx]!)) return null;
  const atPress = walkFrom(base, fixed, waits, departedAt, new Date(pinned.legStartMs)).est;
  if (!atPress.overdue && atPress.segIndex === pinned.segIdx) return fixed;
  const leg = base.segments[pinned.segIdx]!;
  if (leg.span[0] === leg.span[1]) return null;
  return { ...fixed, legStartMs: pinned.legStartMs - (fixMs - fixed.legStartMs), atMs: pinned.legStartMs };
}

/**
 * May a date be printed for this place? ONE rule for every reader — the
 * board, the dashboard, the truck card, «Yuklar», the customer's lot card and
 * Telegram line, the map, the bot and the cabinet map: placed, not overdue,
 * and something left to wait for. «[0, 0]» is a truck due NOW, and a date of
 * «today» renewed every morning for a truck that is not moving is a promise
 * nobody made (the fixes' review: the board printed it while the map printed
 * nothing about the same truck).
 */
export function placeDated(place: Pick<TruckPlace, 'overdue' | 'remainingHours'>): boolean {
  return !place.overdue && place.remainingHours !== null && place.remainingHours[1] > 0;
}

export interface EtaWindow {
  fromIso: string;
  toIso: string;
}

/**
 * The latest moment a placed truck promises — the key the customer's cabinet
 * ranks a lot's trucks by (the latest one dates the lot). Inside its window,
 * the window's far end. A truck held in a queue past its wait
 * (docs/XORGOS-NAVBAT.md) has no date and is NOT «due now»: nobody knows when
 * it leaves, so it ranks with the late ones ('9999') — or a lot split over two
 * trucks shows the OTHER truck's date for the cartons stuck at the border
 * (the design's judge). Anything else with no date is «now».
 */
export function placeArriveBy(
  place: Pick<TruckPlace, 'overdue' | 'remainingHours' | 'queue'>,
  window: EtaWindow | null,
  now: Date,
): string {
  if (window) return window.toIso;
  return place.overdue || place.queue?.over ? '9999' : now.toISOString();
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
export function etaWindow(
  est: Pick<TransitEstimate, 'overdue' | 'remainingHours'>,
  now: Date = new Date(),
): EtaWindow | null {
  if (est.overdue) return null;
  const [min, max] = est.remainingHours;
  return {
    fromIso: new Date(now.getTime() + min * 3_600_000).toISOString(),
    toIso: new Date(now.getTime() + max * 3_600_000).toISOString(),
  };
}
