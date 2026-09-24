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
import { warehousePoint } from '@/modules/wms/tracking/warehouse-point';
import { truckFor } from '@/modules/wms/tracking/truck';
import { TrackingMap, type MapPickup, type MapTruck, type MapWarehouse } from './tracking-map';
import { mayReadPickups, pickupsForMap } from '@/modules/wms/pickups/service';
import { pickupTimeline } from '@/modules/wms/tracking/pickup-route';
import { AutoRefresh } from '@/components/auto-refresh';
import { PageHeader } from '@/components/ui/page';
import { inScope, warehouseScopeEither } from '@/modules/platform/rbac/scope';
import { mayReadBatches } from '@/modules/wms/batches/read-door';

export const dynamic = 'force-dynamic';

const STOCK_STATUSES = ['in_stock', 'planned', 'loading', 'ready_for_pickup'];

/**
 * Corridor map (owner's feature): warehouses with live stock + in-transit
 * trucks placed by the typical-timing simulation. Positions are computed
 * server-side per load — approximate by design, corrected by the manual
 * checkpoint pins on the batch card.
 */
export default async function MapPage({ searchParams }: { searchParams: Promise<{ zr?: string }> }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  // The trucks door, because this page IS the trucks plus every warehouse's
  // stock broken down by client code — the audit found it answering all of
  // that to any signed-in login, including a seller round 91 deliberately
  // scoped to his own clients.
  if (!mayReadBatches(actor.permissions)) redirect('/');
  const t = await getTranslations('map');

  // Warehouses that exist on the corridor drawing, with per-client stock.
  // A warehouse is drawable when the OWNER typed its coordinates (round 100,
  // 9B) or when the built-in dictionary knows its code — db wins, because the
  // whole point of the column is correcting a dot the dictionary put in the
  // wrong place.
  const allWh = await db.select().from(warehouses);
  // A scoped operator's map is his own floor(s): the dots stay (geography is
  // not a secret) but the per-client stock is exactly what the stock screen
  // would refuse him, so it follows the stock screen's fence.
  const whRows = allWh.filter((w) => inScope(actor, w.id));
  const pointFor = (w: (typeof whRows)[number]) => warehousePoint(w);
  const mapped = whRows.filter((w) => pointFor(w) !== null);
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
    const point = pointFor(w)!;
    return {
      id: w.id,
      code: w.code,
      name: w.name,
      x: point.x,
      y: point.y,
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
    .where(
      and(
        eq(batches.status, 'in_transit'),
        // A truck between two countries is judged by its TWO ends — the rule
        // every batch reader states (wms/search, /transit, the documents).
        warehouseScopeEither(actor, batches.originWarehouseId, batches.destWarehouseId),
      ),
    );

  // Real fixes from paired driver phones win over the schedule estimate
  // while they are fresh (owner's flow: Android streams, other phones don't).
  const fixes = await latestPositions(transit.map((t) => t.batch.id));

  const trucks: MapTruck[] = [];
  for (const { batch, originCode, destCode } of transit) {
    const truck = await truckFor(batch, originCode, destCode, fixes.get(batch.id));
    if (truck) trucks.push(truck);
  }

  // Factory trucks (0100) for whoever may open a pickup card — an estimate
  // like every other truck here, built from the same timeline the card uses.
  // Caught: the tables are minted this release (#472).
  const mapPickups: MapPickup[] = mayReadPickups(actor.permissions)
    ? await pickupsForMap()
        .then((rows) =>
          rows.map(({ pickup, destCode, stops }) => {
            const timeline = pickupTimeline(
              stops.map((s) => ({
                point: [Number(s.factory.lon ?? 0), Number(s.factory.lat ?? 0)] as [number, number],
                collectedAt: s.collectedAt,
                leg: s.legPoints && s.legHours ? { points: s.legPoints, hours: s.legHours } : null,
              })),
            );
            return {
              id: pickup.id,
              code: pickup.code,
              destCode,
              factories: stops
                .filter((s) => s.factory.lat !== null && s.factory.lon !== null)
                .map((s) => ({
                  name: s.factory.name,
                  x: Number(s.factory.lon),
                  y: Number(s.factory.lat),
                  collected: Boolean(s.collectedAt),
                })),
              timeline,
              boxes: stops.flatMap((s) => s.lines).reduce((a, l) => a + (l.driverBoxes ?? l.factoryBoxes), 0),
            };
          }),
        )
        // A trip whose first factory has no point has nowhere to be drawn.
        .then((list) => list.filter((p) => p.factories.length > 0))
        .catch(() => [])
    : [];
  const { zr } = await searchParams;
  const focusPickupId = zr && mapPickups.some((p) => p.id === zr) ? zr : null;

  return (
    <div className="mx-auto max-w-5xl space-y-3">
      <PageHeader icon="map" title={t('title')} />
      <p className="text-xs text-ink-500">{t('disclaimer')}</p>
      {/* The lorry moves without a reload (round 100, 9a): the page is
          force-dynamic, so a refresh recomputes every position server-side,
          and the Leaflet layer redraws its markers from the new props while
          the basemap and the user's zoom stay put. */}
      <AutoRefresh ms={60_000} />
      <TrackingMap
        // A retired warehouse is drawn only while cargo still stands in it
        // (the stock picker's rule, #987).
        warehouses={mapWarehouses.filter(
          (w) => allWh.find((row) => row.id === w.id)?.active !== false || w.totalBoxes > 0,
        )}
        trucks={trucks}
        pickups={mapPickups}
        focusPickupId={focusPickupId}
        basemap={basemapAvailable()}
      />
    </div>
  );
}
