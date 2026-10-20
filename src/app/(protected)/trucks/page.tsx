import Link from 'next/link';
import { aliasedTable, and, desc, eq, gte, inArray, ne, or, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { batches, boxes, boxMovements, receiptLots, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { trucksOnRoadRows } from '@/modules/wms/tracking/on-road';
import { truckRoadWords } from '@/components/truck-road';
import { Icon } from '@/components/ui/icon';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { warehouseScopeEither } from '@/modules/platform/rbac/scope';
import { mayReadBatches } from '@/modules/wms/batches/read-door';
import { BorderQueuePanel } from './border-queue-panel';

/**
 * Where every truck is (owner: "/trucks o'rniga «qaysi partiya qayerga yetib
 * bordi»").
 *
 * This slot used to hold the truck-preset CRUD, which is a settings screen
 * someone opens twice a year; it now lives under /admin/trucks. What a logist
 * actually wants from a page called "trucks" is the fleet: which batch is on
 * the road, which has arrived, and where each one physically is.
 */
const ACTIVE = ['forming', 'loading', 'in_transit', 'arrived', 'unloaded'];

export default async function TrucksPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  // The batches screen's own door (wms/batches/read-door.ts) — this page is
  // the same trucks one route over, and it answered to a bare login.
  if (!mayReadBatches(actor.permissions)) redirect('/');
  const t = await getTranslations('trucks');
  const tb = await getTranslations('batches');
  const tbb = await getTranslations('batches.board');
  const format = await getFormatter();
  const params = await searchParams;
  const showClosed = params.all === '1';

  const origin = aliasedTable(warehouses, 'origin_wh');
  const dest = aliasedTable(warehouses, 'dest_wh');
  // Closed trips are history; the default view is what is still moving. The
  // last month of closed ones is enough to answer "when did YW-014 land?".
  const monthAgo = new Date();
  monthAgo.setDate(monthAgo.getDate() - 30);

  const rows = await db
    .select({
      id: batches.id,
      code: batches.code,
      status: batches.status,
      originCode: origin.code,
      destCode: dest.code,
      destCountry: dest.country,
      destId: batches.destWarehouseId,
      vehiclePlate: batches.vehiclePlate,
      driverName: batches.driverName,
      driverPhone: batches.driverPhone,
      departedAt: batches.departedAt,
      arrivedAt: batches.arrivedAt,
      closedAt: batches.closedAt,
      checkpoint: batches.trackingCheckpoint,
      boxCount: sql<number>`count(distinct ${boxes.id})`,
      kg: sql<string>`coalesce(sum(${receiptLots.totalWeightKg} / ${receiptLots.boxCount}), 0)`,
    })
    .from(batches)
    .leftJoin(origin, eq(batches.originWarehouseId, origin.id))
    .leftJoin(dest, eq(batches.destWarehouseId, dest.id))
    .leftJoin(
      boxMovements,
      and(
        eq(boxMovements.refType, 'batch'),
        eq(boxMovements.refId, batches.id),
        eq(boxMovements.cause, 'batch_departed'),
      ),
    )
    // An annulled (void) box is not cargo — the truck list's figures agree
    // with the batch register.
    .leftJoin(boxes, and(eq(boxes.id, boxMovements.boxId), ne(boxes.status, 'void')))
    .leftJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(
      and(
        showClosed
          ? or(inArray(batches.status, ACTIVE), gte(batches.closedAt, monthAgo))
          : inArray(batches.status, ACTIVE),
        warehouseScopeEither(actor, batches.originWarehouseId, batches.destWarehouseId),
      ),
    )
    .groupBy(batches.id, origin.code, dest.code, dest.country)
    .orderBy(desc(batches.departedAt), desc(batches.createdAt))
    .limit(200);

  // Where a truck on the road is: the ONE placement (`placeTruck`, through
  // the dashboard's own row) — the newest of the departure, the pin and the
  // phone's fix, a yard fix from before the departure ignored. This page used
  // to print the raw GPS fix ahead of a newer pin and a pre-departure yard
  // fix as live (the board's review); the board, the dashboard and the map
  // read the same row.
  const roads = await trucksOnRoadRows(rows.filter((row) => row.status === 'in_transit').map((row) => row.id));
  const words = await truckRoadWords({ counts: false });

  const onRoad = rows.filter((row) => row.status === 'in_transit').length;
  const landed = rows.filter((row) => ['arrived', 'unloaded'].includes(row.status)).length;
  const loading = rows.filter((row) => ['forming', 'loading'].includes(row.status)).length;

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-4xl">
      <PageHeader
        icon="truck"
        title={t('title')}
        actions={
          <Link href="/map" className="btn-secondary">
            <Icon name="map" className="h-4 w-4" />
            {t('onMap')}
          </Link>
        }
      />

      {/* The Horgos road's two queues — typed here, read by every date. */}
      <BorderQueuePanel actor={actor} />

      <div className="grid grid-cols-3 gap-2.5">
        <Stat label={t('loading')} value={loading} tone="neutral" />
        <Stat label={t('onRoad')} value={onRoad} tone={onRoad ? 'warn' : 'neutral'} />
        <Stat label={t('landed')} value={landed} tone={landed ? 'good' : 'neutral'} />
      </div>

      {rows.length === 0 ? (
        <EmptyState icon="truck" title={t('empty')} />
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const road = roads.get(row.id);
            return (
              <Link
                key={row.id}
                href={`/batches/${row.id}`}
                data-testid="truck-row"
                className="card-tap block"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono font-extrabold text-brand-700">{row.code}</span>
                  <span className="font-mono text-sm">
                    {row.originCode} → <b>{row.destCode}</b>
                  </span>
                  <span
                    className={`ml-auto ${
                      row.status === 'in_transit'
                        ? 'chip-warn'
                        : ['arrived', 'unloaded'].includes(row.status)
                          ? 'chip-good'
                          : 'chip-neutral'
                    }`}
                  >
                    {tb(`statuses.${row.status}` as 'statuses.forming')}
                  </span>
                </div>

                <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-ink-700">
                  <span className="num">
                    {Number(row.boxCount)} 📦 · {Math.round(Number(row.kg))} kg
                  </span>
                  {row.vehiclePlate && <span className="num font-semibold">{row.vehiclePlate}</span>}
                  {row.driverName && (
                    <span className="text-ink-500">
                      {row.driverName}
                      {row.driverPhone && ` · ${row.driverPhone}`}
                    </span>
                  )}
                </div>

                {/* Where it is: the arrival if it landed, otherwise the
                    board's own words for the truck on the road. */}
                <div className="mt-1 text-xs">
                  {row.arrivedAt ? (
                    <span className="font-semibold text-good">
                      🏁 {t('arrivedAt', { wh: row.destCode ?? '' })} ·{' '}
                      {format.dateTime(new Date(row.arrivedAt), { dateStyle: 'short' })}
                    </span>
                  ) : road ? (
                    <span data-testid="truck-row-road" className="text-ink-600">
                      📍{' '}
                      <span className={`font-semibold ${road.kind === 'overdue' ? 'text-warn' : ''}`}>
                        {words.word(road)}
                      </span>
                      {road.roadPct !== null && <> · {tbb('roadPct', { pct: road.roadPct })}</>} · {words.sentence(road)}
                    </span>
                  ) : row.departedAt ? (
                    <span className="text-ink-500">
                      🚀 {format.dateTime(new Date(row.departedAt), { dateStyle: 'short' })} ·{' '}
                      {t('noSignal')}
                    </span>
                  ) : (
                    <span className="text-ink-500">{t('notDeparted')}</span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}

      <Link
        href={showClosed ? '/trucks' : '/trucks?all=1'}
        className="block text-center text-sm font-semibold text-brand-700"
      >
        {showClosed ? t('activeOnly') : t('showClosed')}
      </Link>
    </div>
  );
}
