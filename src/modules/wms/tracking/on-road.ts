import { cache } from 'react';
import { and, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches } from '../../platform/db/schema';
import { tashkentDay } from '../../platform/time/tashkent';
import { batchEndsWhere, inTransitBatches } from '../reports/queries';
import { awaitingUnloadCounts } from '../scanning/unload';
import { latestPositions } from './devices';
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
 * Four statements whatever the fleet: the in-transit report and the loading
 * count, then — for the SLICED rows only — the newest position and the boxes
 * still on board. Membership and the box count are `inTransitBatches`' (the
 * XLSX and the attention row read the same rows); every date and percentage
 * comes from `on-road-state.ts` through `eta.ts`, so the card, the map and the
 * customer's cabinet cannot say different things about one lorry. This file
 * never estimates anything itself — no `truckFor` (one contents query PER
 * truck, for a popup this card does not draw), no `routeFor`.
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

  const [inputs, loadingRow] = await Promise.all([
    inTransitBatches(warehouseIds),
    db
      .select({ n: sql<number>`count(*)` })
      .from(batches)
      .where(and(inArray(batches.status, [...LOADING_STATUSES]), batchEndsWhere(warehouseIds))),
  ]);

  const byId = new Map<string, TruckInput>(inputs.map((r) => [r.id, r]));
  const ranked = rankTrucks(inputs.map((r) => truckRow(r, now, today)));
  const counts = zeroCounts();
  for (const r of ranked) counts[r.kind] += 1;

  const sliced = ranked.slice(0, Math.max(0, opts.limit));
  const ids = sliced.map((r) => r.id);
  const arrivedIds = sliced.filter((r) => r.status === 'arrived').map((r) => r.id);
  const [positions, awaiting] = await Promise.all([
    latestPositions(ids),
    awaitingUnloadCounts(arrivedIds),
  ]);

  const rows = sliced.map((row) =>
    enrichedRow(byId.get(row.id)!, row, positions, awaiting, now, today),
  );

  return { rows, total: ranked.length, counts, loading: Number(loadingRow[0]?.n ?? 0) };
}

/**
 * Re-derived from the enriched input rather than patched onto the row, so
 * truckRow stays the one place a row's fields are decided. The enrichment
 * changes no kind and no order: a position never moves the schedule (the
 * map's own rule) and the unload count is not what makes a truck stuck.
 */
function enrichedRow(
  input: TruckInput,
  row: TruckRow,
  positions: Map<string, { recordedAt: Date }>,
  awaiting: Map<string, number>,
  now: Date,
  today: string,
): TruckRow {
  return truckRow(
    {
      ...input,
      awaitingUnload: row.status === 'arrived' ? (awaiting.get(row.id) ?? 0) : null,
      lastPositionAt: positions.get(row.id)?.recordedAt ?? null,
    },
    now,
    today,
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
  const now = new Date();
  const today = tashkentDay(now);
  const [input] = await inTransitBatches(undefined, { batchIds: [batchId] });
  if (!input) return null;
  const row = truckRow(input, now, today);
  const [positions, awaiting] = await Promise.all([
    latestPositions([batchId]),
    awaitingUnloadCounts(row.status === 'arrived' ? [batchId] : []),
  ]);
  return enrichedRow(input, row, positions, awaiting, now, today);
});
