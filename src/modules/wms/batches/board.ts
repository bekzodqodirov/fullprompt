import { aliasedTable, and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, factories, pickupStops, warehouses } from '../../platform/db/schema';
import { warehouseScopeEither, type ScopedActor } from '../../platform/rbac/scope';
import { pickupEstimate } from '../pickups/eta';
import { INCOMING_STALE_DAYS, mayReadPickups, OPEN_STATUSES } from '../pickups/service';
import { qrlessUncountedByTruck } from '../scanning/service';
import { checkpointsFor, isGenericRoute } from '../tracking/eta';
import { CHECKPOINT_KEYS, routeFor, type CheckpointKey } from '../tracking/map-data';
import { trucksOnRoadRows } from '../tracking/on-road';
import type { TruckRow } from '../tracking/on-road-state';
import {
  roadBands,
  routeFilterOf,
  tripRoadSection,
  warehouseSection,
  type BoardColumn,
  type CardPlacement,
  type CardWarning,
  type RoadBand,
} from './board-view';
import { batchLoadTotals, type LoadMeasure } from './card-head';
import { countryKey } from './country-key';
import { riderLoad, riderRowsSql } from './riders';

/**
 * The batch board's reads (docs/PARTIYA-DOSKASI.md §3-§4): every open truck
 * in the viewer's scope and every open factory trip the viewer may read, as
 * cards `board-view.ts` places, filters and counts.
 *
 * Nothing here is a new rule about a truck. What it carries is the truck
 * header's load (`batchLoadTotals`), what rode (`riderLoad`), the dashboard's
 * row for a truck on the road or at its gate (`trucksOnRoadRows` — so the
 * board's place, % and date are the dashboard's, the map's and the
 * cabinet's), the count chip's set (`qrlessUncountedByTruck`) and the trip
 * card's own estimate (`pickupEstimate`). A fixed number of statements for
 * any fleet (#432): rows, totals, riders, dates, the road rows, the chip, and
 * two for the trips.
 */

/** A safety net, not a page: far above any day's open fleet, and said when it bites. */
export const BOARD_CAP = 1000;

const OPEN_BATCH_STATUSES = ['forming', 'loading', 'in_transit', 'arrived'] as const;
type OpenBatchStatus = (typeof OPEN_BATCH_STATUSES)[number];

const COLUMN_OF: Record<OpenBatchStatus, BoardColumn> = {
  forming: 'forming',
  loading: 'loading',
  in_transit: 'road',
  arrived: 'arrived',
};

export interface BoardTruck extends CardPlacement {
  type: 'batch';
  id: string;
  status: OpenBatchStatus;
  originCode: string;
  originName: string;
  destCode: string;
  destName: string;
  plate: string | null;
  /** As typed — the card prints it; `telOf` makes the `tel:` link. */
  driverPhone: string | null;
  /** Forming and loading: the header's numbers (7a). Null = nothing on the pointer. */
  load: { loaded: LoadMeasure; planned: LoadMeasure } | null;
  /** Departed: what RODE (`riderLoad`). */
  rode: LoadMeasure | null;
  /** First and last carton of the CURRENT cargo (6c), ISO; null before the first scan. */
  loadFrom: string | null;
  loadTo: string | null;
  departedAt: string | null;
  arrivedAt: string | null;
  /** The dashboard's row (`trucksOnRoadRows`): on the road or at its gate. */
  road: TruckRow | null;
  /** The bar's places, by distance (4a); only beside a %. */
  bar: { bands: RoadBand[]; notches: number[] } | null;
  /** «sanash kutilmoqda»: a QR-siz lot nobody counted (plans.manage only). */
  awaitingCount: boolean;
  /**
   * The ⋯ pins (10b): offered only on the road to a `batches.vehicle_info`
   * holder. `current` is the STORED key — what the CAS compares against, so a
   * pin the road no longer carries is still the one the screen «saw».
   */
  pins: { current: CheckpointKey | null; options: CheckpointKey[] } | null;
}

export interface BoardTrip extends CardPlacement {
  type: 'trip';
  id: string;
  status: (typeof OPEN_STATUSES)[number];
  destCode: string;
  destName: string;
  plate: string | null;
  driverPhone: string | null;
  stops: number;
  collected: number;
  /** The driver's recount over the factory's count, per line (B2). */
  boxes: number;
  /** Known sums, and how many lines carry no figure («noma'lum»). */
  m3: number;
  m3Missing: number;
  kg: number;
  kgMissing: number;
  lines: number;
  plannedOn: string | null;
  collectedFrom: string | null;
  collectedTo: string | null;
  arrivedAt: string | null;
  /** On the road: the trip card's own arrival range, ISO; never a % (B3). */
  arrival: { from: string; to: string } | null;
}

export type BoardCard = BoardTruck | BoardTrip;

export interface BoardActor extends ScopedActor {
  permissions: ReadonlySet<string>;
}

export interface BoardData {
  cards: BoardCard[];
  /** The truck or trip list hit `BOARD_CAP`; the page says so. */
  capped: boolean;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

/** No border crossed — his «ichki reys» (12A): both ends in one country. */
function crossesNoBorder(originCountry: string | null, destCountry: string | null): boolean {
  const o = countryKey(originCountry);
  return o !== '' && o === countryKey(destCountry);
}

/**
 * Which factory trips the viewer reads (§4): the list's door → every open
 * trip, a warehouse-scoped holder's own destinations only (a role grant must
 * not widen the board past its trucks); `receipts.create` → the trips coming
 * to their warehouses, without the stale arrived ones (/receive's rule);
 * otherwise none.
 */
export function tripSight(actor: BoardActor): { warehouseIds: string[] | null; fresh: boolean } | null {
  const own = actor.warehouseScoped ? actor.warehouseIds : null;
  if (mayReadPickups(actor.permissions)) return { warehouseIds: own, fresh: false };
  if (actor.permissions.has('receipts.create')) return { warehouseIds: own, fresh: true };
  return null;
}

export async function loadBoard(actor: BoardActor, now: Date = new Date()): Promise<BoardData> {
  const [trucks, trips] = await Promise.all([boardTrucks(actor), boardTrips(actor, now)]);
  return { cards: [...trucks.cards, ...trips.cards], capped: trucks.capped || trips.capped };
}

async function boardTrucks(actor: BoardActor): Promise<{ cards: BoardTruck[]; capped: boolean }> {
  const dest = aliasedTable(warehouses, 'dest');
  const found = await db
    .select({
      id: batches.id,
      code: batches.code,
      status: batches.status,
      createdAt: batches.createdAt,
      departedAt: batches.departedAt,
      arrivedAt: batches.arrivedAt,
      plate: batches.vehiclePlate,
      driverPhone: batches.driverPhone,
      checkpoint: batches.trackingCheckpoint,
      originId: batches.originWarehouseId,
      originCode: warehouses.code,
      originName: warehouses.name,
      originCountry: warehouses.country,
      originType: warehouses.type,
      destId: batches.destWarehouseId,
      destCode: dest.code,
      destName: dest.name,
      destCountry: dest.country,
      destType: dest.type,
    })
    .from(batches)
    .innerJoin(warehouses, eq(batches.originWarehouseId, warehouses.id))
    .innerJoin(dest, eq(batches.destWarehouseId, dest.id))
    .where(
      and(
        inArray(batches.status, [...OPEN_BATCH_STATUSES]),
        warehouseScopeEither(actor, batches.originWarehouseId, batches.destWarehouseId),
      ),
    )
    // Oldest first, so a cap would drop the newest truck and never the one
    // that has stood longest (the stuck ones are the old ones).
    .orderBy(asc(batches.createdAt))
    .limit(BOARD_CAP + 1);
  const capped = found.length > BOARD_CAP;
  const rows = found.slice(0, BOARD_CAP);

  const idsOf = (statuses: readonly string[]) => rows.filter((r) => statuses.includes(r.status)).map((r) => r.id);
  const loadingIds = idsOf(['forming', 'loading']);
  const departedIds = idsOf(['in_transit', 'arrived']);
  const [totals, rode, dates, road, awaiting] = await Promise.all([
    batchLoadTotals(loadingIds),
    riderLoad(departedIds),
    loadDates(idsOf(['loading', 'in_transit', 'arrived'])),
    trucksOnRoadRows(departedIds),
    actor.permissions.has('plans.manage')
      ? qrlessUncountedByTruck(db, loadingIds)
      : Promise.resolve(new Map<string, unknown>()),
  ]);
  const mayPin = actor.permissions.has('batches.vehicle_info');

  const cards = rows.map((r): BoardTruck => {
    const status = r.status as OpenBatchStatus;
    const column = COLUMN_OF[status];
    const truck = road.get(r.id) ?? null;
    const route = routeFor(r.originCode, r.destCode);
    const mapped = route && !isGenericRoute(route) ? route : null;
    const section =
      column === 'road'
        ? (truck?.zone ?? 'unknown')
        : column === 'arrived'
          ? warehouseSection(r.destCountry, r.destType)
          : warehouseSection(r.originCountry, r.originType);
    const warnings: CardWarning[] = [];
    if (awaiting.has(r.id)) warnings.push('count');
    if (truck?.kind === 'overdue') warnings.push('overdue');
    if (truck?.kind === 'stuck') warnings.push('stuck');
    const rawPin = (r.checkpoint as { key?: unknown } | null)?.key;
    const storedPin =
      typeof rawPin === 'string' && (CHECKPOINT_KEYS as readonly string[]).includes(rawPin)
        ? (rawPin as CheckpointKey)
        : null;
    // The Mashina tab's options, minus the pin already standing: pressing it
    // would CLEAR it, and clearing stays on the Mashina tab.
    const pinnable = mayPin && status === 'in_transit';
    const pinOptions = pinnable
      ? checkpointsFor(r.originCode, r.destCode, r.destCountry).filter((key) => key !== storedPin)
      : [];
    const rider = rode.get(r.id);
    const date = dates.get(r.id);
    return {
      type: 'batch',
      key: `b:${r.id}`,
      id: r.id,
      code: r.code,
      status,
      column,
      section,
      transitLeg:
        column === 'road' && truck?.zone === 'transit' && (truck.segKey === 'kg' || truck.segKey === 'kz')
          ? truck.segKey
          : null,
      warehouseIds: [r.originId, r.destId],
      route: routeFilterOf(mapped),
      internal: crossesNoBorder(r.originCountry, r.destCountry),
      warnings,
      order: new Date(
        (column === 'road' ? r.departedAt : column === 'arrived' ? r.arrivedAt : null) ?? r.createdAt,
      ).getTime(),
      originCode: r.originCode,
      originName: r.originName,
      destCode: r.destCode,
      destName: r.destName,
      plate: r.plate,
      driverPhone: r.driverPhone,
      load: column === 'forming' || column === 'loading' ? (totals.get(r.id) ?? null) : null,
      rode: rider ? { boxes: rider.boxCount, kg: rider.kg, m3: rider.m3 } : null,
      loadFrom: date?.from ?? null,
      loadTo: date?.to ?? null,
      departedAt: iso(r.departedAt),
      arrivedAt: iso(r.arrivedAt),
      road: truck,
      bar: column === 'road' && mapped && truck?.roadPct != null ? roadBands(mapped) : null,
      awaitingCount: awaiting.has(r.id),
      pins: pinnable && (pinOptions.length > 0 || storedPin) ? { current: storedPin, options: pinOptions } : null,
    };
  });
  return { cards, capped };
}

/**
 * The first and the last carton of each truck's CURRENT cargo (his 6c): the
 * riders minus what is still only reserved, each carton's LATEST load scan on
 * THIS truck — a carton scanned by mistake, taken off and scanned again is
 * dated by the scan that stood — timed `least(scanned_at, created_at)`: the
 * phone's clock is not trusted to be later than the server's, and an offline
 * scan arriving late is dated by when it was taken. Kept between the truck's
 * creation and its departure, so a phone set a year wrong prints the truck's
 * own days. A carton that rode with no load scan dates nothing.
 */
async function loadDates(batchIds: string[]): Promise<Map<string, { from: string; to: string }>> {
  const out = new Map<string, { from: string; to: string }>();
  const ids = [...new Set(batchIds)];
  if (ids.length === 0) return out;
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    WITH riders AS (${riderRowsSql({ batches: list })}),
    cargo AS (
      SELECT r.batch_id, r.box_id
        FROM riders r
        JOIN boxes b ON b.id = r.box_id
       WHERE NOT (b.current_batch_id = r.batch_id AND b.status = 'planned')
    ),
    scanned AS (
      SELECT c.batch_id, greatest(bt.created_at, least(s.at, bt.departed_at)) AS at
        FROM cargo c
        JOIN batches bt ON bt.id = c.batch_id
        JOIN LATERAL (
          SELECT max(least(se.scanned_at, se.created_at)) AS at
            FROM scan_events se
           WHERE se.batch_id = c.batch_id AND se.box_id = c.box_id AND se.type = 'load'
        ) s ON s.at IS NOT NULL
    )
    SELECT batch_id, min(at) AS first_at, max(at) AS last_at
      FROM scanned
     GROUP BY batch_id
  `)) as unknown as { batch_id: string; first_at: string | Date; last_at: string | Date }[];
  // A raw statement hands timestamps back as TEXT (#925): read through Date.
  for (const row of rows) out.set(row.batch_id, { from: iso(row.first_at)!, to: iso(row.last_at)! });
  return out;
}

interface TripRow {
  id: string;
  code: string;
  status: (typeof OPEN_STATUSES)[number];
  dest_id: string;
  dest_code: string;
  dest_name: string;
  dest_country: string | null;
  dest_type: string | null;
  plate: string | null;
  driver_phone: string | null;
  planned_on: string | null;
  created_at: string | Date;
  started_at: string | Date | null;
  arrived_at: string | Date | null;
  stale: boolean;
  stops: number;
  collected: number;
  first_at: string | Date | null;
  last_at: string | Date | null;
  lines: number;
  boxes: number;
  m3: string;
  m3_missing: number;
  kg: string;
  kg_missing: number;
}

const TRIP_COLUMN: Record<(typeof OPEN_STATUSES)[number], BoardColumn> = {
  planned: 'forming',
  on_road: 'road',
  arrived: 'arrived',
};

async function boardTrips(actor: BoardActor, now: Date): Promise<{ cards: BoardTrip[]; capped: boolean }> {
  const sight = tripSight(actor);
  if (!sight || (sight.warehouseIds && sight.warehouseIds.length === 0)) return { cards: [], capped: false };
  const scope = sight.warehouseIds
    ? sql`AND p.dest_warehouse_id IN (${sql.join(
        sight.warehouseIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql``;
  const stale = sql`(p.status = 'arrived' AND coalesce(p.arrived_at, p.created_at) <= now() - make_interval(days => ${INCOMING_STALE_DAYS}))`;
  const open = sql.join(
    OPEN_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  const found = (await db.execute(sql`
    SELECT p.id, p.code, p.status, p.dest_warehouse_id AS dest_id,
           w.code AS dest_code, w.name AS dest_name, w.country AS dest_country, w.type AS dest_type,
           p.vehicle_plate AS plate, p.driver_phone, p.planned_on::text AS planned_on,
           p.created_at, p.started_at, p.arrived_at,
           ${stale} AS stale,
           st.stops, st.collected, st.first_at, st.last_at,
           ln.lines, ln.boxes, ln.m3, ln.m3_missing, ln.kg, ln.kg_missing
      FROM pickups p
      JOIN warehouses w ON w.id = p.dest_warehouse_id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS stops, count(ps.collected_at)::int AS collected,
               min(ps.collected_at) AS first_at, max(ps.collected_at) AS last_at
          FROM pickup_stops ps WHERE ps.pickup_id = p.id
      ) st ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS lines,
               coalesce(sum(coalesce(pl.driver_boxes, pl.factory_boxes)), 0)::int AS boxes,
               coalesce(sum(pl.volume_m3), 0) AS m3,
               (count(*) FILTER (WHERE pl.volume_m3 IS NULL))::int AS m3_missing,
               coalesce(sum(pl.weight_kg), 0) AS kg,
               (count(*) FILTER (WHERE pl.weight_kg IS NULL))::int AS kg_missing
          FROM pickup_stops ps JOIN pickup_lines pl ON pl.stop_id = ps.id
         WHERE ps.pickup_id = p.id
      ) ln ON true
     WHERE p.status IN (${open}) ${scope}
       ${sight.fresh ? sql`AND NOT ${stale}` : sql``}
     ORDER BY p.created_at
     LIMIT ${BOARD_CAP + 1}
  `)) as unknown as TripRow[];
  const capped = found.length > BOARD_CAP;
  const rows = found.slice(0, BOARD_CAP);

  // The trip card's own estimate, for the trips on the road — the stops in
  // order with their factories and their stored legs.
  const onRoad = rows.filter((r) => r.status === 'on_road').map((r) => r.id);
  const stops = onRoad.length
    ? await db
        .select({
          pickupId: pickupStops.pickupId,
          collectedAt: pickupStops.collectedAt,
          legPoints: pickupStops.legPoints,
          legHours: pickupStops.legHours,
          lat: factories.lat,
          lon: factories.lon,
        })
        .from(pickupStops)
        .innerJoin(factories, eq(pickupStops.factoryId, factories.id))
        .where(inArray(pickupStops.pickupId, onRoad))
        .orderBy(pickupStops.pickupId, pickupStops.seq)
    : [];
  const stopsBy = new Map<string, typeof stops>();
  for (const s of stops) stopsBy.set(s.pickupId, [...(stopsBy.get(s.pickupId) ?? []), s]);

  const cards = rows.map((r): BoardTrip => {
    const column = TRIP_COLUMN[r.status];
    const own = stopsBy.get(r.id);
    const eta = own
      ? pickupEstimate(
          own.map((s) => ({
            factory: { lat: s.lat, lon: s.lon },
            collectedAt: s.collectedAt,
            legPoints: s.legPoints,
            legHours: s.legHours === null ? null : Number(s.legHours),
          })),
          now.getTime(),
        ).eta
      : null;
    return {
      type: 'trip',
      key: `p:${r.id}`,
      id: r.id,
      code: r.code,
      status: r.status,
      column,
      section: column === 'road' ? tripRoadSection(r.dest_country) : warehouseSection(r.dest_country, r.dest_type),
      transitLeg: null,
      warehouseIds: [r.dest_id],
      route: null,
      internal: false,
      warnings: r.stale ? ['stale'] : [],
      order: new Date(
        (column === 'road' ? r.started_at : column === 'arrived' ? r.arrived_at : null) ?? r.created_at,
      ).getTime(),
      destCode: r.dest_code,
      destName: r.dest_name,
      plate: r.plate,
      driverPhone: r.driver_phone,
      stops: Number(r.stops ?? 0),
      collected: Number(r.collected ?? 0),
      boxes: Number(r.boxes ?? 0),
      m3: Number(r.m3 ?? 0),
      m3Missing: Number(r.m3_missing ?? 0),
      kg: Number(r.kg ?? 0),
      kgMissing: Number(r.kg_missing ?? 0),
      lines: Number(r.lines ?? 0),
      plannedOn: r.planned_on,
      collectedFrom: iso(r.first_at),
      collectedTo: iso(r.last_at),
      arrivedAt: iso(r.arrived_at),
      arrival: eta ? { from: new Date(eta.from).toISOString(), to: new Date(eta.to).toISOString() } : null,
    };
  });
  return { cards, capped };
}
