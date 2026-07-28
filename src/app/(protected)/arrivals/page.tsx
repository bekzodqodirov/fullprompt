import Link from 'next/link';
import { asc, eq, inArray } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { incomingTrucks, listExpected } from '@/modules/wms/arrivals/service';
import { Panel } from '@/components/panel';
import { Icon } from '@/components/ui/icon';
import { EmptyState, PageHeader } from '@/components/ui/page';
import { ArrivalForm } from './arrival-form';
import { cancelArrivalAction, markArrivedAction } from './actions';

/**
 * What is on its way HERE (owner's item 3).
 *
 * A Chinese warehouse's arrivals are cargo the sales side was told about
 * days ago; an Uzbek warehouse's are our own trucks, already on the road.
 * Both were invisible to the receiving warehouse until they were in the
 * building, so they share one screen — "what should I expect today".
 */
export default async function ArrivalsPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const canReceive = actor.permissions.has('receipts.create');
  const canPromise = canReceive || actor.permissions.has('crm.leads');
  if (!canPromise && !actor.permissions.has('scan.unload')) redirect('/');

  const t = await getTranslations('arrivals');
  const tc = await getTranslations('common');
  const format = await getFormatter();
  const today = new Date().toISOString().slice(0, 10);

  // An empty array, not undefined: a scoped person with no warehouse must
  // see nothing rather than everything.
  const scoped = actor.warehouseScoped ? actor.warehouseIds : undefined;
  const [expected, trucks, whs] = await Promise.all([
    listExpected(scoped),
    incomingTrucks(scoped),
    db
      .select({ id: warehouses.id, code: warehouses.code })
      .from(warehouses)
      .where(
        scoped ? inArray(warehouses.id, scoped) : eq(warehouses.active, true),
      )
      .orderBy(asc(warehouses.code)),
  ]);

  const late = expected.filter((row) => row.expectedOn && row.expectedOn < today).length;

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <PageHeader icon="inbox" title={t('title')} />

      {/* Our own trucks first when there are any: a truck at the gate is the
          more urgent of the two, and it is scanned, not typed. */}
      <section className="space-y-2">
        <p className="section-title">
          🚛 {t('trucksTitle')} {trucks.length > 0 && `· ${trucks.length}`}
        </p>
        {trucks.length === 0 ? (
          <p className="card text-sm text-ink-500">{t('noTrucks')}</p>
        ) : (
          trucks.map((truck) => (
            <Link
              key={truck.batchId}
              href={
                actor.permissions.has('scan.unload')
                  ? `/batches/${truck.batchId}/unload`
                  : `/batches/${truck.batchId}`
              }
              data-testid="incoming-truck"
              className="card-tap block"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono font-extrabold text-brand-700">{truck.code}</span>
                <span className="font-mono text-xs text-ink-500">
                  {truck.originCode} → {truck.destCode}
                </span>
                <span
                  className={`ml-auto ${truck.status === 'arrived' ? 'chip-good' : 'chip-warn'}`}
                >
                  {t(`status.${truck.status}` as 'status.in_transit')}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-2 text-sm">
                <span className="num text-ink-700">
                  {truck.boxCount} 📦 · {truck.kg} kg
                </span>
                {truck.vehiclePlate && <span className="num text-xs">{truck.vehiclePlate}</span>}
                {truck.driverName && <span className="text-xs text-ink-500">{truck.driverName}</span>}
                <span className="num ml-auto font-bold text-warn">
                  {t('remaining', { n: truck.remaining })}
                </span>
              </div>
              {truck.departedAt && (
                <p className="mt-0.5 text-xs text-ink-500">
                  🚀 {format.dateTime(new Date(truck.departedAt), { dateStyle: 'short' })}
                </p>
              )}
            </Link>
          ))
        )}
      </section>

      <section className="space-y-2">
        <p className="section-title">
          📦 {t('expectedTitle')} {expected.length > 0 && `· ${expected.length}`}
          {late > 0 && <span className="ml-2 text-warn">⚠️ {late}</span>}
        </p>

        {canPromise && whs.length > 0 && (
          <Panel title={`➕ ${t('addTitle')}`}>
            <ArrivalForm warehouses={whs} today={today} />
          </Panel>
        )}

        {expected.length === 0 ? (
          <EmptyState icon="inbox" title={t('noExpected')} />
        ) : (
          expected.map((row) => (
            <div key={row.id} data-testid="expected-row" className="card space-y-1.5">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono font-bold">{row.warehouseCode}</span>
                {row.clientId ? (
                  <Link
                    href={`/admin/clients/${row.clientId}`}
                    className="font-mono font-extrabold text-brand-700"
                  >
                    {row.clientCode}
                  </Link>
                ) : (
                  <span className="num font-semibold">{row.marking}</span>
                )}
                {row.clientName && (
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-700">{row.clientName}</span>
                )}
                {row.expectedOn && (
                  <span
                    className={`num ml-auto whitespace-nowrap text-xs font-semibold ${
                      row.expectedOn < today ? 'text-warn' : 'text-ink-500'
                    }`}
                  >
                    {row.expectedOn < today && '⚠️ '}
                    {row.expectedOn}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-baseline gap-2 text-sm text-ink-500">
                {row.boxCount !== null && <span className="num">≈ {row.boxCount} 📦</span>}
                {row.weightKg !== null && <span className="num">⚖️ {row.weightKg} kg</span>}
                {row.volumeM3 !== null && <span className="num">📐 {row.volumeM3} m³</span>}
                {row.clientId && row.marking && <span className="num">{row.marking}</span>}
                {row.note && <span className="min-w-0 flex-1 truncate">{row.note}</span>}
              </div>
              {canReceive && (
                <div className="flex flex-wrap gap-2 border-t border-line pt-2">
                  {/* The normal path: receive the cargo. The promise id rides
                      along, so the receiving screen opens pre-filled and the
                      confirm closes THIS promise — no walking back here to
                      press "arrived" (owner: "bu juda noqulay"). */}
                  <Link
                    href={`/receive?arrival=${row.id}`}
                    data-testid="receive-expected"
                    className="btn-primary min-w-0 flex-1"
                  >
                    <Icon name="inbox" className="h-4 w-4" />
                    {t('receiveIt')}
                  </Link>
                  <form action={markArrivedAction}>
                    <input type="hidden" name="id" value={row.id} />
                    <button type="submit" className="btn-secondary" title={t('markArrived')}>
                      ✅
                    </button>
                  </form>
                  <form action={cancelArrivalAction} className="flex gap-1">
                    <input type="hidden" name="id" value={row.id} />
                    <input
                      name="reason"
                      className="input !w-28"
                      placeholder={t('cancelReason')}
                      maxLength={200}
                    />
                    <button type="submit" className="btn-secondary text-bad" title={tc('delete')}>
                      ✖
                    </button>
                  </form>
                </div>
              )}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
