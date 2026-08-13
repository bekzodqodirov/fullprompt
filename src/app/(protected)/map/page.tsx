import { and, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  clients,
  receiptLots,
  receipts,
  warehouses,
} from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { basemapAvailable } from '@/modules/wms/tracking/basemap';
import { latestPositions } from '@/modules/wms/tracking/devices';
import { WAREHOUSE_POINTS } from '@/modules/wms/tracking/map-data';
import { truckFor } from '@/modules/wms/tracking/truck';
import { TrackingMap, type MapTruck, type MapWarehouse } from './tracking-map';
import { PageHeader } from '@/components/ui/page';

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
      id: w.id,
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
      <PageHeader icon="map" title={t('title')} />
      <p className="text-xs text-ink-500">{t('disclaimer')}</p>
      <TrackingMap warehouses={mapWarehouses} trucks={trucks} basemap={basemapAvailable()} />
    </div>
  );
}
