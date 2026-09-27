import { isMovingStage, truckStage, type TruckStage } from '../client-cabinet/stages';
import { daysSince } from '../reports/dashboard-math';
import { etaWindow, scheduleEstimate } from './eta';

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
 * the rule used to be a literal `>= 2` in two section files.
 */
export const STUCK_AT_GATE_DAYS = 2;

/** The attention list's «stuck» predicate, stated once (#513). */
export function isStuckAtGate(
  row: { status: string; arrivedAt: Date | string | null },
  today: string,
): boolean {
  return row.status === 'arrived' && daysSince(row.arrivedAt, today) >= STUCK_AT_GATE_DAYS;
}

/** The three positions the batch card's «где машина» pins can record. */
export type CheckpointKey = 'at_border' | 'in_kg' | 'in_uz';
const CHECKPOINT_KEYS: ReadonlySet<string> = new Set<CheckpointKey>(['at_border', 'in_kg', 'in_uz']);

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
  lastPositionAt?: Date | null;
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
  /** round(progress × 100) by the schedule's TIME; null: no/generic schedule, arrived, overdue. */
  roadPct: number | null;
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

function checkpointOf(raw: unknown): { key: CheckpointKey; at: string } | null {
  const cp = raw as { key?: unknown; at?: unknown } | null;
  if (!cp || typeof cp.key !== 'string' || typeof cp.at !== 'string' || !cp.at) return null;
  if (!CHECKPOINT_KEYS.has(cp.key)) return null;
  if (Number.isNaN(new Date(cp.at).getTime())) return null;
  return { key: cp.key as CheckpointKey, at: cp.at };
}

/**
 * One truck → one row. `now` drives the schedule (hours) and `today` the
 * calendar (Tashkent days) — both passed in, so a test pins both clocks.
 */
export function truckRow(input: TruckInput, now: Date, today: string): TruckRow {
  const arrived = input.status === 'arrived';
  const checkpoint = checkpointOf(input.trackingCheckpoint);
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
    lastPositionAt: input.lastPositionAt ?? null,
  };

  if (arrived) {
    const days = daysSince(input.arrivedAt, today);
    return {
      ...base,
      kind: isStuckAtGate(input, today) ? 'stuck' : 'unloading',
      stage: null,
      roadPct: null,
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
  const off = { ...base, stage, days, awaitingUnload: null };

  // The ONE assembler: an unmapped pair, a generic straight line and a truck
  // with no departure stamp all come back null here — «no schedule».
  const schedule = scheduleEstimate(
    input.originCode,
    input.destCode,
    input.departedAt,
    input.trackingCheckpoint,
    now,
  );
  if (!schedule) {
    return { ...off, kind: 'no_schedule', roadPct: null, eta: null, arrivalOrder: null };
  }
  if (schedule.est.overdue) {
    return { ...off, kind: 'overdue', roadPct: null, eta: null, arrivalOrder: null };
  }
  return {
    ...off,
    kind: 'on_road',
    roadPct: Math.round(schedule.est.progress * 100),
    eta: isMovingStage(stage) ? etaWindow(schedule.est, now) : null,
    arrivalOrder: schedule.est.remainingHours[0],
  };
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
      const longer = b.days - a.days;
      if (longer !== 0) return longer;
    }
    return a.code.localeCompare(b.code);
  });
}
