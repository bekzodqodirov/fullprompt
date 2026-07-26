import Link from 'next/link';
import { aliasedTable, and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { batches, boxes, boxMovements, receiptLots, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { latestPositions } from '@/modules/wms/tracking/devices';
import { Icon } from '@/components/ui/icon';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';

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
  const t = await getTranslations('trucks');
  const tb = await getTranslations('batches');
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
    .leftJoin(boxes, eq(boxes.id, boxMovements.boxId))
    .leftJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(
      and(
        showClosed
          ? or(inArray(batches.status, ACTIVE), gte(batches.closedAt, monthAgo))
          : inArray(batches.status, ACTIVE),
        actor.warehouseScoped && actor.warehouseIds.length
          ? or(
              inArray(batches.originWarehouseId, actor.warehouseIds),
              inArray(batches.destWarehouseId, actor.warehouseIds),
            )
          : undefined,
      ),
    )
    .groupBy(batches.id, origin.code, dest.code)
    .orderBy(desc(batches.departedAt), desc(batches.createdAt))
    .limit(200);

  // The real GPS fix, when the driver's phone is paired and reporting.
  const positions = await latestPositions(rows.map((row) => row.id));

  const onRoad = rows.filter((row) => row.status === 'in_transit').length;
  const landed = rows.filter((row) => ['arrived', 'unloaded'].includes(row.status)).length;
  const loading = rows.filter((row) => ['forming', 'loading'].includes(row.status)).length;

  const CHECKPOINTS: Record<string, string> = {
    at_border: `🛃 ${tb('cpBorder')}`,
    in_kg: `🇰🇬 ${tb('cpKg')}`,
    in_uz: `🇺🇿 ${tb('cpUz')}`,
  };

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
            const position = positions.get(row.id);
            const checkpoint = (row.checkpoint as { key?: string } | null)?.key;
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

                {/* Where it actually is: the arrival if it landed, otherwise
                    the newest GPS fix, otherwise the logist's manual pin. */}
                <div className="mt-1 flex flex-wrap items-baseline gap-x-3 text-xs">
                  {row.arrivedAt ? (
                    <span className="font-semibold text-good">
                      🏁 {t('arrivedAt', { wh: row.destCode ?? '' })} ·{' '}
                      {format.dateTime(new Date(row.arrivedAt), { dateStyle: 'short' })}
                    </span>
                  ) : position ? (
                    <span className={position.fresh ? 'text-good' : 'text-ink-500'}>
                      📍 {position.lat.toFixed(2)}, {position.lon.toFixed(2)} ·{' '}
                      {position.fresh
                        ? t('freshFix', { h: Math.round(position.ageMinutes / 60) })
                        : t('staleFix')}
                    </span>
                  ) : checkpoint ? (
                    <span className="text-ink-500">{CHECKPOINTS[checkpoint]}</span>
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
