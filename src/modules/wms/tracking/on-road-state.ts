import { isMovingStage, truckStage, type TruckStage } from '../client-cabinet/stages';
import { daysSince } from '../reports/dashboard-math';
import {
  etaWindow,
  pinOnRoute,
  placeDated,
  placeTruck,
  type BorderHours,
  type PlaceSource,
  type PlacementFix,
  type TruckPlace,
} from './eta';
import type { CheckpointKey } from './map-data';
import type { RoadZone } from './place';

/**
 * «Yo'ldagi mashinalar» — what the owner's dashboard says about each truck,
 * decided here with no database and no clock of its own, so every sentence
 * the card prints is a table test (round B).
 *
 * Nothing in this file is a new rule about trucks. The schedule and its pin
 * are `eta.ts`'s (the map and the customer's cabinet read the same one), the
 * rung is the cabinet's own ladder (`truckStage`), «days» are whole Tashkent
 * days (`daysSince`, the attention list's clock) and the box count is the
 * in-transit report's. What this file adds is only the CLASSIFICATION the
 * card sorts by, and the refusals that keep the card from saying more than
 * is known:
 *
 * - no percentage and no date for a truck with no schedule (an unmapped or a
 *   generic route, or no departure stamp) — `null`, never 0, because «0 %»
 *   and «~0–0 kun» are claims (the map popup's old defect);
 * - no date once the schedule is spent (`overdue`) — `map.overdue`'s
 *   sentence instead, the map's own wording for the same truck (O16);
 * - no date on a rung the customer is shown no date for: a truck the logist
 *   pinned in Uzbekistan is «O'zbekistonda» in the cabinet, and the office
 *   must not read a date the customer cannot (O15);
 * - «days» is days on the road, or days AT THE GATE once arrived — a pin is
 *   printed as a dated fact («belgi 2 kun oldin»), never as «still there».
 */

/**
 * A truck standing at its destination unloaded for this many Tashkent days
 * is «stuck». ONE number for the attention list's row and the card's chip —
 * for a truck arrived by its scan (`arrivedAt`) AND one arrived by its phone
 * (`gateSince`, the first fix at its yard), so the two are flagged on one
 * clock; the rule used to be a literal `>= 2` in two section files.
 */
export const STUCK_AT_GATE_DAYS = 2;

/** The attention list's «stuck» predicate, stated once (#513). */
export function isStuckAtGate(
  row: { status: string; arrivedAt: Date | string | null },
  today: string,
): boolean {
  return row.status === 'arrived' && daysSince(row.arrivedAt, today) >= STUCK_AT_GATE_DAYS;
}

/** At its gate by the phone: Tashkent days since its first fix there; null anywhere else. */
export function gateDaysOf(place: Pick<TruckPlace, 'atGate' | 'gateSince'>, today: string): number | null {
  return place.atGate && place.gateSince ? daysSince(place.gateSince, today) : null;
}

/** `isStuckAtGate`'s clock for a truck the PHONE put at its gate — one rule for the row, the map and the bot. */
export function stuckAtPhoneGate(gateDays: number | null): boolean {
  return gateDays !== null && gateDays >= STUCK_AT_GATE_DAYS;
}

/**
 * Since when an ARRIVED truck has stood at its gate: its first unload scan,
 * or the phone's first yard fix before it when that came earlier — ONE clock
 * for the office row, the map and the bot (the first scan used to reset it to
 * «bugun yetib keldi»). `arrived_at` itself is never back-dated: the lead
 * clock and the calc actuals read it.
 */
export function stoodSince(arrivedAt: Date | null, yardSince: Date | null): Date | null {
  if (!arrivedAt) return yardSince;
  if (!yardSince) return arrivedAt;
  return yardSince.getTime() < arrivedAt.getTime() ? yardSince : arrivedAt;
}

export type TruckKind = 'stuck' | 'overdue' | 'unloading' | 'on_road' | 'no_schedule';

/** Exported so a literal chip map can be typed `Record<TruckKind, …>` and a new kind fails the build. */
export const TRUCK_KINDS: readonly TruckKind[] = ['stuck', 'overdue', 'unloading', 'on_road', 'no_schedule'];

/**
 * One row of `inTransitBatches` — structurally, so this file needs no
 * database import — plus the two facts the query adds for the rows the card
 * actually draws. Absent enrichment reads as «not asked», never as zero.
 */
export interface TruckInput {
  id: string;
  code: string;
  originCode: string;
  originName: string;
  originCountry: string | null;
  destCode: string;
  destName: string;
  destCountry: string | null;
  status: string;
  departedAt: Date | null;
  arrivedAt: Date | null;
  trackingCheckpoint: unknown;
  customsClearedAt: Date | null;
  /** What DEPARTED on the truck (void boxes out) — the report's own count. */
  boxCount: number;
  awaitingUnload?: number | null;
  /**
   * The driver's newest fix (`latestPositions`). It PLACES the truck (his 5a,
   * `placeTruck`), so it is read for every truck before the rank — a fix can
   * move a truck from «overdue» back onto the road and change the counts.
   */
  fix?: PlacementFix | null;
  /**
   * ARRIVED: since when the phone had it in its yard before the first unload
   * scan (`gateSinceFor`, bounded at `arrivedAt`) — the scan must not restart
   * the clock it has stood on. Absent = nobody asked, the scan's own time.
   */
  yardSince?: Date | null;
}

export interface TruckRow {
  id: string;
  code: string;
  originCode: string;
  originName: string;
  destCode: string;
  destName: string;
  status: 'in_transit' | 'arrived';
  kind: TruckKind;
  /** The customer's rung for this truck; null once it has arrived. */
  stage: TruckStage | null;
  /**
   * round(progress × 100) — the road's LENGTH behind the truck (4a), from the
   * newest evidence (`placeTruck`). Null: no/generic schedule, arrived, and an
   * overdue truck nothing but its departure places.
   */
  roadPct: number | null;
  /** Where on the road and on which leg (`placeTruck`); null on an arrived truck. */
  zone: RoadZone | null;
  segKey: string | null;
  /** What placed it — the phone, a typed position, the pin, the schedule — and when. */
  source: PlaceSource | null;
  evidenceAt: string | null;
  /** The fix that placed it is within FRESH_MINUTES. */
  fresh: boolean;
  /** The phone put it at its destination's gate (`placeTruck`): no date, not late, not yet unloaded. */
  atGate: boolean;
  /** At the gate by the phone: Tashkent days since its first fix there; null otherwise (an arrived row too). */
  gateDays: number | null;
  /**
   * ARRIVED: the phone's first yard fix, when it came on an earlier Tashkent
   * day than the first unload scan — printed as a past fact («GPS: hovliga
   * 16.10 kirgan»), never as a running count: the phone saw the yard only
   * until the scan (the eighth recheck). Null otherwise.
   */
  yardFrom: Date | null;
  /**
   * Since when it has stood at its gate (`stoodSince` for an arrived truck;
   * the phone's first yard fix for one still in transit); null on the road.
   * The clock «stuck», the board's arrived column and the dashboard's waiting
   * trucks order by — NEVER printed: «Keldi» stays the first unload scan on
   * every screen (the seventh recheck found every printed arrival date
   * contradicting another once it moved), and the phone's earlier yard time
   * is its own past fact (`yardFrom`).
   */
  stoodSince: Date | null;
  /** Only on a MOVING rung (`isMovingStage`), with a schedule, not overdue. */
  eta: { fromIso: string; toIso: string } | null;
  departedAt: Date | null;
  arrivedAt: Date | null;
  /** Tashkent days on the road — or at the gate once arrived (`daysSince`). */
  days: number;
  /** «jo'nagan: N» — what departed, labelled as such (O18: three homes count a truck's boxes). */
  departedBoxes: number;
  /** Arrived only: `remainingToUnload`'s WHERE, counted. Null on the road or when not asked. */
  awaitingUnload: number | null;
  checkpoint: { key: CheckpointKey; at: string } | null;
  /** Tashkent days since the pin — a dated fact, not «still there». */
  pinDays: number | null;
  /** The driver app's newest position, if any — freshness is printed apart from the ETA. */
  lastPositionAt: Date | null;
  /**
   * Hours to the schedule's EARLIEST arrival, for ORDERING the on-road rows
   * and nothing else — it exists on a rung the customer is shown no date for,
   * so it must never be printed (O15). Null wherever `roadPct` is.
   */
  arrivalOrder: number | null;
}

/**
 * One truck → one row. `now` drives the schedule (hours) and `today` the
 * calendar (Tashkent days) — both passed in, so a test pins both clocks.
 * `waits` is the logist's typed border queues (`loadBorderHours`), loaded
 * ONCE by the caller for the whole list (#432) — `{}` = nothing typed.
 *
 * The pin is `pinOnRoute`'s: a key the batch card never writes, or one this
 * truck's road does not carry (a Kyrgyz pin on a Kazakh road), is no
 * checkpoint — not drawn, and not the anchor of any date.
 */
export function truckRow(input: TruckInput, now: Date, today: string, waits: BorderHours): TruckRow {
  const arrived = input.status === 'arrived';
  const checkpoint = pinOnRoute(
    input.trackingCheckpoint,
    input.originCode,
    input.destCode,
    input.destCountry,
  );
  const base = {
    id: input.id,
    code: input.code,
    originCode: input.originCode,
    originName: input.originName,
    destCode: input.destCode,
    destName: input.destName,
    status: (arrived ? 'arrived' : 'in_transit') as TruckRow['status'],
    departedAt: input.departedAt,
    arrivedAt: input.arrivedAt,
    departedBoxes: input.boxCount,
    checkpoint,
    pinDays: checkpoint ? daysSince(checkpoint.at, today) : null,
    lastPositionAt: input.fix?.recordedAt ?? null,
  };

  if (arrived) {
    // «Keldi» is the scan (`days`); whether it stands too long is judged by
    // the phone's yard time when that came first — one clock for the two
    // arrivals, which the scan used to reset (the fifth recheck) — and that
    // time is said apart as a past fact (`yardFrom`).
    const stood = stoodSince(input.arrivedAt, input.yardSince ?? null);
    const days = daysSince(input.arrivedAt, today);
    const earlierDay = input.yardSince && daysSince(input.yardSince, today) > days ? input.yardSince : null;
    return {
      ...base,
      kind: isStuckAtGate({ status: 'arrived', arrivedAt: stood }, today) ? 'stuck' : 'unloading',
      stage: null,
      roadPct: null,
      zone: null,
      segKey: null,
      source: null,
      evidenceAt: null,
      fresh: false,
      atGate: false,
      gateDays: null,
      yardFrom: earlierDay,
      stoodSince: stood,
      eta: null,
      days,
      awaitingUnload: input.awaitingUnload ?? null,
      arrivalOrder: null,
    };
  }

  const stage = truckStage({
    originCountry: input.originCountry,
    destCountry: input.destCountry,
    status: input.status,
    checkpointKey: checkpoint?.key ?? null,
    customsCleared: input.customsClearedAt !== null,
  });
  const days = daysSince(input.departedAt, today);

  // The ONE assembler (`placeTruck`): an unmapped pair, a generic straight
  // line and a truck with no departure stamp come back with no road walked
  // — «no schedule» — and every other truck is placed by its newest
  // evidence: the departure, the pin, or the driver's fix.
  const place = placeTruck(
    {
      originCode: input.originCode,
      destCode: input.destCode,
      originCountry: input.originCountry,
      destCountry: input.destCountry,
      departedAt: input.departedAt,
      checkpoint: input.trackingCheckpoint,
      fix: input.fix ?? null,
    },
    waits,
    now,
  );
  const off = {
    ...base,
    stage,
    days,
    awaitingUnload: null,
    zone: place.zone,
    segKey: place.segKey,
    source: place.source,
    evidenceAt: place.evidenceAt,
    fresh: place.fresh,
    atGate: place.atGate,
    gateDays: gateDaysOf(place, today),
    yardFrom: null,
    stoodSince: place.atGate && place.gateSince ? new Date(place.gateSince) : null,
  };
  const pct = place.progress === null ? null : Math.round(place.progress * 100);
  if (place.atGate) {
    // Arrived by the phone, waiting for the scan: first in the list, no date
    // — and «stuck», counted by the attention row and the 20:00 summary, on
    // the arrived truck's own clock: STUCK_AT_GATE_DAYS since it came.
    return stuckAtPhoneGate(off.gateDays)
      ? { ...off, kind: 'stuck', roadPct: pct, eta: null, arrivalOrder: null }
      : { ...off, kind: 'on_road', roadPct: pct, eta: null, arrivalOrder: 0 };
  }
  if (!place.route) {
    return { ...off, kind: 'no_schedule', roadPct: null, eta: null, arrivalOrder: null };
  }
  if (place.overdue || !place.remainingHours) {
    // Spent: no date. The bar stays where the newest evidence last put the
    // truck, and is absent when only the departure speaks.
    return { ...off, kind: 'overdue', roadPct: pct, eta: null, arrivalOrder: null };
  }
  return {
    ...off,
    kind: 'on_road',
    roadPct: pct,
    // `placeDated` is the one rule every reader asks (a truck due NOW has no
    // date to print).
    eta:
      isMovingStage(stage) && placeDated(place)
        ? etaWindow({ overdue: false, remainingHours: place.remainingHours }, now)
        : null,
    arrivalOrder: place.remainingHours[0],
  };
}

/**
 * What a truck AT ITS GATE is called — the word the four screens print
 * (`truckRoadWords`), decided here so it is a table test. With nothing left
 * to scan off it is unloaded and only the «Razgruzkani yakunlash» press is
 * missing: «Tushirilmay turibdi» beside «Tushirildi 40 / 40» contradicted
 * itself (the board's review). The KIND stays — the counts and the attention
 * row still see a truck nobody has finished, which is still somebody's job.
 * Null on the road, and when the unload count was not asked (`null`); a
 * truck the phone put at its gate is «stuck» on the same clock, else null.
 */
export function gateWord(
  row: Pick<TruckRow, 'status' | 'kind' | 'awaitingUnload' | 'atGate'>,
): 'unloaded_open' | 'stuck' | 'unloading' | null {
  // At its gate by the phone (still «in transit» — nobody scanned it off):
  // standing there past the stuck days is the arrived truck's own word.
  if (row.status !== 'arrived') return row.atGate && row.kind === 'stuck' ? 'stuck' : null;
  if (row.awaitingUnload === 0) return 'unloaded_open';
  return row.kind === 'stuck' ? 'stuck' : 'unloading';
}

/**
 * What a date on the road was walked from, as its qualifier names it (§2:
 * «the date's qualifier says its source»): the phone (or a typed position),
 * the logist's pin, or the bare schedule. A date walked from a pin was called
 * a plain schedule estimate (the review).
 */
export function estimateBasis(source: PlaceSource | null): 'gps' | 'pin' | 'schedule' {
  if (source === 'gps' || source === 'manual') return 'gps';
  return source === 'pin' ? 'pin' : 'schedule';
}

/**
 * How old a fix is, as a person reads it: «hozirgina» under five minutes,
 * then minutes, hours up to two days, days after. Rounded DOWN, so «1 soat»
 * never means 31 minutes (the /trucks page printed «0 soat oldin» for a fix
 * taken a quarter of an hour ago). Pure, beside the row it dates.
 */
export function fixAge(minutes: number): { unit: 'now' | 'min' | 'hour' | 'day'; n: number } {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 5) return { unit: 'now', n: 0 };
  if (m < 60) return { unit: 'min', n: m };
  if (m < 48 * 60) return { unit: 'hour', n: Math.floor(m / 60) };
  return { unit: 'day', n: Math.floor(m / (24 * 60)) };
}

const KIND_RANK: Record<TruckKind, number> = {
  stuck: 0,
  overdue: 1,
  unloading: 2,
  on_road: 3,
  no_schedule: 4,
};

/**
 * The card's order: what needs a person first. Stuck at a gate, then past
 * its schedule — each longest first, the one that has waited most is the
 * one to ring about — then the trucks being unloaded, then the road by the
 * soonest arrival, then the ones nobody can place. Ties by code, so a
 * re-render never shuffles two equal rows.
 */
export function rankTrucks(rows: TruckRow[]): TruckRow[] {
  return [...rows].sort((a, b) => {
    const kind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (kind !== 0) return kind;
    if (a.kind === 'on_road') {
      const soon = (a.arrivalOrder ?? Infinity) - (b.arrivalOrder ?? Infinity);
      if (soon !== 0 && !Number.isNaN(soon)) return soon;
    } else {
      // Longest standing first: since it came to its gate when it is at one
      // (the board's own arrived order — an arrived row's `days` count the
      // scan, the eighth recheck), else days on the road.
      const longer =
        a.stoodSince && b.stoodSince ? a.stoodSince.getTime() - b.stoodSince.getTime() : b.days - a.days;
      if (longer !== 0) return longer;
    }
    return a.code.localeCompare(b.code);
  });
}
