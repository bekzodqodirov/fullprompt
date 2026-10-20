import { cache } from 'react';
import { and, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches } from '../../platform/db/schema';
import { tashkentDay } from '../../platform/time/tashkent';
import { batchEndsWhere, inTransitBatches } from '../reports/queries';
import { awaitingUnloadCounts } from '../scanning/unload';
import { loadBorderHours } from './border-queue';
import { gateSinceFor, latestPositions, placementFix, type LatestPosition, type PositionTrip } from './devices';
import type { BorderHours } from './eta';
import {
  rankTrucks,
  TRUCK_KINDS,
  truckRow,
  type TruckInput,
  type TruckKind,
  type TruckRow,
} from './on-road-state';

/**
 * The statuses of a truck that is being LOADED: `forming` is a plan approved
 * and nothing scanned yet, `loading` flips on the first scan — the loading
 * screen takes scans on both, and the warehouse home's «yuklanmoqda» row
 * counts both (`home/flow.ts`). A count only (O17): the loading screen's
 * done/planned counter lives in the phone and includes scans still queued
 * offline, so a done/planned read here would disagree with it for exactly as
 * long as the warehouse has no signal.
 */
const LOADING_STATUSES = ['forming', 'loading'] as const;

export interface TrucksOnRoad {
  rows: TruckRow[];
  /** Every truck in scope, before the slice — the card's «hammasi (N)». */
  total: number;
  /** Over ALL trucks in scope, not the slice. */
  counts: Record<TruckKind, number>;
  /** Trucks being loaded at either end of the scope. */
  loading: number;
}

function zeroCounts(): Record<TruckKind, number> {
  return Object.fromEntries(TRUCK_KINDS.map((k) => [k, 0])) as Record<TruckKind, number>;
}

/**
 * The dashboard's trucks card: every truck on the road or standing at its
 * destination gate, classified and ranked, `limit` of them drawn.
 *
 * Five statements whatever the fleet: the in-transit report, the loading
 * count and the queues, then the newest fix of EVERY truck in scope — a fix
 * places the truck (his 5a), so it decides kinds, counts and the order, and
 * read for the slice alone it would rank one way and draw another — then,
 * for the SLICED rows only, the boxes still on board. Membership and the box
 * count are `inTransitBatches`' (the XLSX and the attention row read the same
 * rows); every date and percentage comes from `on-road-state.ts` through
 * `eta.ts`, so the card, the map and the customer's cabinet cannot say
 * different things about one lorry. This file never estimates anything
 * itself — no `truckFor` (one contents query PER truck, for a popup this card
 * does not draw), no `routeFor`.
 *
 * `warehouseIds`: undefined = the whole company; a list = either end in it.
 * An EMPTY list is a scoped viewer with no warehouse and answers NOTHING —
 * `inTransitBatches` reads `[]` as «no filter», so without this refusal the
 * person with no warehouses would see every truck in the company.
 */
export async function trucksOnRoad(
  warehouseIds: string[] | undefined,
  opts: { limit: number; now?: Date },
): Promise<TrucksOnRoad> {
  if (warehouseIds && warehouseIds.length === 0) {
    return { rows: [], total: 0, counts: zeroCounts(), loading: 0 };
  }
  const now = opts.now ?? new Date();
  const today = tashkentDay(now);

  const [inputs, loadingRow, waits] = await Promise.all([
    inTransitBatches(warehouseIds),
    db
      .select({ n: sql<number>`count(*)` })
      .from(batches)
      .where(and(inArray(batches.status, [...LOADING_STATUSES]), batchEndsWhere(warehouseIds))),
    // The logist's typed border queues — once for the whole card (#432).
    loadBorderHours(),
  ]);

  const [positions, yards] = await readEvidence(inputs);
  const placed = inputs.map((r) => withFix(r, positions, yards));
  const byId = new Map<string, TruckInput>(placed.map((r) => [r.id, r]));
  const ranked = rankTrucks(placed.map((r) => truckRow(r, now, today, waits)));
  const counts = zeroCounts();
  for (const r of ranked) counts[r.kind] += 1;

  const sliced = ranked.slice(0, Math.max(0, opts.limit));
  const arrivedIds = sliced.filter((r) => r.status === 'arrived').map((r) => r.id);
  const awaiting = await awaitingUnloadCounts(arrivedIds);

  const rows = sliced.map((row) => enrichedRow(byId.get(row.id)!, row, awaiting, now, today, waits));

  return { rows, total: ranked.length, counts, loading: Number(loadingRow[0]?.n ?? 0) };
}

/**
 * A truck on the road is placed by its positions; one ARRIVED keeps only
 * since when the phone had it in the yard before the first unload scan
 * (`until`), so that scan does not restart its «stuck» clock (the fifth
 * recheck) — its newest fix is nobody's evidence, so it is not read (the
 * sixth: every fix a paired phone sends on the drive home was).
 */
const tripOf = (r: TruckInput): PositionTrip => ({
  id: r.id,
  originCode: r.originCode,
  destCode: r.destCode,
  departedAt: r.departedAt,
  until: r.status === 'arrived' ? r.arrivedAt : null,
});

function readEvidence(inputs: TruckInput[]): Promise<[Map<string, LatestPosition>, Map<string, Date>]> {
  return Promise.all([
    latestPositions(inputs.filter((r) => r.status === 'in_transit').map(tripOf)),
    gateSinceFor(inputs.filter((r) => r.status === 'arrived').map(tripOf)),
  ]);
}

/** The input with its evidence: the newest fix `placeTruck` places it by, or the arrived truck's yard time. */
function withFix(input: TruckInput, positions: Map<string, LatestPosition>, yards: Map<string, Date>): TruckInput {
  return {
    ...input,
    fix: placementFix(positions.get(input.id)),
    yardSince: input.status === 'arrived' ? (yards.get(input.id) ?? null) : null,
  };
}

/**
 * Re-derived from the enriched input rather than patched onto the row, so
 * truckRow stays the one place a row's fields are decided. The unload count
 * changes no kind and no order: it is not what makes a truck stuck.
 */
function enrichedRow(
  input: TruckInput,
  row: TruckRow,
  awaiting: Map<string, number>,
  now: Date,
  today: string,
  waits: BorderHours,
): TruckRow {
  return truckRow(
    { ...input, awaitingUnload: row.status === 'arrived' ? (awaiting.get(row.id) ?? 0) : null },
    now,
    today,
    waits,
  );
}

/**
 * ONE truck's row, assembled exactly as the dashboard's trucks card
 * assembles each of its rows — the same report row, the same enrichment, the
 * same `truckRow` — so the truck card's ETA sentence is the dashboard's
 * sentence about the same lorry. Null unless the truck is on the road or at
 * its gate: fed an unloaded truck, `truckRow` would call it overdue.
 */
export const truckOnRoadRow = cache(async function truckOnRoadRow(batchId: string): Promise<TruckRow | null> {
  return (await trucksOnRoadRows([batchId])).get(batchId) ?? null;
});

/**
 * Several trucks' rows at once, each assembled as `truckOnRoadRow` assembles
 * one — for a surface that names many lorries (the client card's «Yuklar»
 * tab: every truck a client's cargo is riding). Four statements for any
 * number of trucks, never four per truck (#432). A truck not on the road or
 * at its gate is simply absent, for the reason `truckOnRoadRow` states.
 */
export async function trucksOnRoadRows(batchIds: string[]): Promise<Map<string, TruckRow>> {
  const out = new Map<string, TruckRow>();
  const ids = [...new Set(batchIds)];
  if (ids.length === 0) return out;
  const now = new Date();
  const today = tashkentDay(now);
  const [inputs, waits] = await Promise.all([
    inTransitBatches(undefined, { batchIds: ids }),
    loadBorderHours(),
  ]);
  if (inputs.length === 0) return out;
  const [[positions, yards], awaiting] = await Promise.all([
    readEvidence(inputs),
    awaitingUnloadCounts(inputs.filter((r) => r.status === 'arrived').map((r) => r.id)),
  ]);
  for (const raw of inputs) {
    const input = withFix(raw, positions, yards);
    const row = truckRow(input, now, today, waits);
    out.set(input.id, enrichedRow(input, row, awaiting, now, today, waits));
  }
  return out;
}
