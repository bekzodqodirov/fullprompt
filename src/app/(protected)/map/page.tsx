import { and, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clients,
  receiptLots,
  receipts,
  warehouses,
} from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { basemapAvailable } from '@/modules/wms/tracking/basemap';
import { latestPositions, type LatestPosition } from '@/modules/wms/tracking/devices';
import { estimateTransit } from '@/modules/wms/tracking/engine';
import { CHECKPOINT_SEGMENTS, routeFor, WAREHOUSE_POINTS } from '@/modules/wms/tracking/map-data';
import { TrackingMap, type MapTruck, type MapWarehouse } from './tracking-map';

export const dynamic = 'force-dynamic';

const STOCK_STATUSES = ['in_stock', 'planned', 'loading', 'ready_for_pickup'];

/**
 * Corridor map (owner's feature): warehouses with live stock + in-transit
 * trucks placed by the typical-timing simulation. Positions are computed
 * server-side per load — approximate by design, corrected by the manual
 * checkpoint pins on the batch card.
 */
export default async function MapPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('map');

  // Warehouses that exist on the corridor drawing, with per-client stock.
  const whRows = await db.select().from(warehouses);
  const mapped = whRows.filter((w) => WAREHOUSE_POINTS[w.code.toUpperCase()]);
  const stockRows = mapped.length
    ? await db
        .select({
          warehouseId: boxes.currentWarehouseId,
          clientCode: sql<string | null>`coalesce(${clients.clientCode}, ${receipts.unclaimedMarking})`,
          n: sql<number>`count(*)`,
        })
        .from(boxes)
        .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
        .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
        .leftJoin(clients, eq(receipts.clientId, clients.id))
        .where(
          and(
            inArray(boxes.status, STOCK_STATUSES),
            inArray(boxes.currentWarehouseId, mapped.map((w) => w.id)),
          ),
        )
        .groupBy(boxes.currentWarehouseId, sql`coalesce(${clients.clientCode}, ${receipts.unclaimedMarking})`)
    : [];
  const stockByWh = new Map<string, { clientCode: string; n: number }[]>();
  for (const row of stockRows) {
    if (!row.warehouseId) continue;
    const list = stockByWh.get(row.warehouseId) ?? [];
    list.push({ clientCode: row.clientCode ?? '?', n: Number(row.n) });
    stockByWh.set(row.warehouseId, list);
  }
  const mapWarehouses: MapWarehouse[] = mapped.map((w) => {
    const stock = (stockByWh.get(w.id) ?? []).sort((a, b) => b.n - a.n);
    return {
      code: w.code,
      name: w.name,
      x: WAREHOUSE_POINTS[w.code.toUpperCase()]!.x,
      y: WAREHOUSE_POINTS[w.code.toUpperCase()]!.y,
      totalBoxes: stock.reduce((a, s) => a + s.n, 0),
      stock: stock.slice(0, 12),
    };
  });

  // In-transit trucks with contents (departed movements are ground truth).
  const origin = alias(warehouses, 'origin_wh');
  const dest = alias(warehouses, 'dest_wh');
  const transit = await db
    .select({
      batch: batches,
      originCode: origin.code,
      destCode: dest.code,
    })
    .from(batches)
    .innerJoin(origin, eq(batches.originWarehouseId, origin.id))
    .innerJoin(dest, eq(batches.destWarehouseId, dest.id))
    .where(eq(batches.status, 'in_transit'));

  // Real fixes from paired driver phones win over the schedule estimate
  // while they are fresh (owner's flow: Android streams, other phones don't).
  const fixes = await latestPositions(transit.map((t) => t.batch.id));

  const trucks: MapTruck[] = [];
  for (const { batch, originCode, destCode } of transit) {
    const truck = await truckFor(batch, originCode, destCode, fixes.get(batch.id));
    if (truck) trucks.push(truck);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-3">
      <h1 className="text-xl font-bold">🗺 {t('title')}</h1>
      <p className="text-xs text-gray-500">{t('disclaimer')}</p>
      <TrackingMap warehouses={mapWarehouses} trucks={trucks} basemap={basemapAvailable()} />
    </div>
  );
}

/** Estimate + contents for one in-transit batch (null = not on the map). */
async function truckFor(
  batch: typeof batches.$inferSelect,
  originCode: string,
  destCode: string,
  fix?: LatestPosition,
): Promise<MapTruck | null> {
  const route = routeFor(originCode, destCode);
  if (!route || !batch.departedAt) return null;
  const cp = batch.trackingCheckpoint as { key?: string; at?: string } | null;
  const anchorSeg = cp?.key ? CHECKPOINT_SEGMENTS[cp.key] : undefined;
  const anchor =
    anchorSeg && cp?.at
      ? { segKey: anchorSeg, elapsedInSegHours: (Date.now() - new Date(cp.at).getTime()) / 3_600_000 }
      : null;
  const est = estimateTransit(
    route,
    (Date.now() - new Date(batch.departedAt).getTime()) / 3_600_000,
    anchor,
  );

  const contents = await db
      .select({
        clientCode: sql<string | null>`coalesce(${clients.clientCode}, ${receipts.unclaimedMarking})`,
        n: sql<number>`count(distinct ${boxes.id})`,
      })
      .from(boxMovements)
      .innerJoin(boxes, eq(boxMovements.boxId, boxes.id))
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .leftJoin(clients, eq(receipts.clientId, clients.id))
      .where(
        and(
          eq(boxMovements.refType, 'batch'),
          eq(boxMovements.refId, batch.id),
          eq(boxMovements.cause, 'batch_departed'),
        ),
      )
      .groupBy(sql`coalesce(${clients.clientCode}, ${receipts.unclaimedMarking})`);

  // A fresh fix from the driver's phone replaces the estimated dot; a stale
  // one is kept as information but the schedule drives the marker again.
  const live = fix?.fresh ? fix : null;

  return {
    batchId: batch.id,
    code: batch.code,
    originCode,
    destCode,
    x: live ? live.lon : est.x,
    y: live ? live.lat : est.y,
    live: live !== null,
    fixAgeMinutes: fix?.ageMinutes ?? null,
    fixSource: fix?.source ?? null,
    segKey: est.segKey,
    progress: est.progress,
    overdue: est.overdue,
    remainingDays: [
      Math.round((est.remainingHours[0] / 24) * 10) / 10,
      Math.round((est.remainingHours[1] / 24) * 10) / 10,
    ],
    departedAt: batch.departedAt.toISOString(),
    checkpointKey: cp?.key ?? null,
    vehiclePlate: batch.vehiclePlate,
    routePoints: route.points,
    contents: contents
      .map((c) => ({ clientCode: c.clientCode ?? '?', n: Number(c.n) }))
      .sort((a, b) => b.n - a.n),
  };
}
