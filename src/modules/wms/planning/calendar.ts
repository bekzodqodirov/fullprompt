import { and, asc, eq, gte, isNotNull, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, expectedArrivals, clients, warehouses } from '../../platform/db/schema';

/**
 * What is happening on the road, as calendar entries (owner: "ha yaxshi bo'lar
 * edi" — trucks on the calendar too).
 *
 * Read-only and derived: nothing here is stored twice. A departure is
 * `batches.departed_at`, an arrival is `batches.arrived_at`, and a promised
 * delivery is an `expected_arrivals` row — so the calendar cannot disagree
 * with the truck board, and a batch corrected on its own card is corrected
 * here in the same moment.
 *
 * Lives in wms because it reads wms tables; the calendar PAGE merges it with
 * the platform-level tasks rather than either module knowing about the other.
 */

export interface CalendarEvent {
  kind: 'departed' | 'arrived' | 'expected';
  /** `YYYY-MM-DD`, the day it belongs on. */
  day: string;
  label: string;
  href: string;
  icon: string;
}

export async function roadEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
  const start = new Date(from);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(23, 59, 59, 999);

  const origin = warehouses;
  const dest = sql<string>`(SELECT code FROM warehouses WHERE id = ${batches.destWarehouseId})`;

  const trips = await db
    .select({
      id: batches.id,
      code: batches.code,
      plate: batches.vehiclePlate,
      departedAt: batches.departedAt,
      arrivedAt: batches.arrivedAt,
      originCode: origin.code,
      destCode: dest,
    })
    .from(batches)
    .innerJoin(origin, eq(batches.originWarehouseId, origin.id))
    .where(
      and(
        ne(batches.status, 'forming'),
        or(
          and(gte(batches.departedAt, start), lte(batches.departedAt, end)),
          and(gte(batches.arrivedAt, start), lte(batches.arrivedAt, end)),
        ),
      ),
    )
    .orderBy(asc(batches.departedAt))
    .limit(500);

  const events: CalendarEvent[] = [];
  for (const trip of trips) {
    const route = `${trip.originCode} → ${trip.destCode}`;
    const plate = trip.plate ? ` ${trip.plate}` : '';
    if (trip.departedAt && trip.departedAt >= start && trip.departedAt <= end) {
      events.push({
        kind: 'departed',
        day: trip.departedAt.toISOString().slice(0, 10),
        label: `${trip.code} ${route}${plate}`,
        href: `/batches/${trip.id}`,
        icon: '🚚',
      });
    }
    if (trip.arrivedAt && trip.arrivedAt >= start && trip.arrivedAt <= end) {
      events.push({
        kind: 'arrived',
        day: trip.arrivedAt.toISOString().slice(0, 10),
        label: `${trip.code} ${route}`,
        href: `/batches/${trip.id}`,
        icon: '🏁',
      });
    }
  }

  // Cargo a client promised: still waiting, and dated. An arrival that already
  // happened is a receipt, and it belongs to the receipt list rather than here.
  const promised = await db
    .select({
      id: expectedArrivals.id,
      day: expectedArrivals.expectedOn,
      boxCount: expectedArrivals.boxCount,
      marking: expectedArrivals.marking,
      whCode: warehouses.code,
      clientCode: clients.clientCode,
    })
    .from(expectedArrivals)
    .innerJoin(warehouses, eq(expectedArrivals.warehouseId, warehouses.id))
    .leftJoin(clients, eq(expectedArrivals.clientId, clients.id))
    .where(
      and(
        eq(expectedArrivals.status, 'waiting'),
        isNotNull(expectedArrivals.expectedOn),
        gte(expectedArrivals.expectedOn, start.toISOString().slice(0, 10)),
        lte(expectedArrivals.expectedOn, end.toISOString().slice(0, 10)),
      ),
    )
    .limit(500);

  for (const row of promised) {
    events.push({
      kind: 'expected',
      day: row.day!,
      label: `${row.clientCode ?? row.marking ?? '❓'} → ${row.whCode}${
        row.boxCount ? ` · ${row.boxCount}` : ''
      }`,
      href: '/arrivals',
      icon: '📦',
    });
  }

  return events;
}
