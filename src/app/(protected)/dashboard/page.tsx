import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { getSetting } from '@/modules/platform/settings/service';
import {
  agingSummary,
  costMissingBatches,
  discrepancySummary,
  inTransitBatches,
  recentReceipts,
  stockByWarehouse,
  unclaimedSummary,
  warehouseFill,
} from '@/modules/wms/reports/queries';
import { PageHeader } from '@/components/ui/page';

/**
 * Role-aware dashboard (spec §13): admin/logist see every warehouse,
 * warehouse staff their own. The warehouse-fill card lives HERE, not on the
 * home screen (owner's request). Sales managers get the pipeline instead.
 */
export default async function DashboardPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const allWh = actor.permissions.has('reports.all_warehouses');
  const ownWh = actor.permissions.has('reports.own_warehouse');
  if (!allWh && !ownWh) {
    redirect(actor.permissions.has('reports.own_clients') ? '/pipeline' : '/');
  }
  const scope = allWh ? undefined : actor.warehouseIds;
  const t = await getTranslations('dashboard');
  const format = await getFormatter();
  const staleDays = Number(await getSetting('stale_stock_days')) || 30;

  const [fills, stock, receipts24, transit, unclaimed, aging, flags, costMissing] =
    await Promise.all([
      warehouseFill(scope),
      stockByWarehouse(scope),
      recentReceipts(scope),
      inTransitBatches(scope),
      unclaimedSummary(scope),
      agingSummary(staleDays, scope),
      discrepancySummary(scope),
      // Costing hygiene (spec 6.9): departed > 3 days with zero cost entries.
      allWh ? costMissingBatches(3) : Promise.resolve([]),
    ]);

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-4xl">
      <div className="flex items-baseline gap-2">
        <PageHeader icon="chart" title={t('title')} />
        <Link href="/reports" className="ml-auto text-sm font-semibold text-brand-700">
          {t('toReports')} →
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {fills.length > 0 && (
          <div className="card space-y-2 !p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              {t('fill')}
            </p>
            {fills.map((fill) => {
              const color =
                fill.pct >= 80 ? 'bg-red-600' : fill.pct >= 60 ? 'bg-yellow-500' : 'bg-green-600';
              const text =
                fill.pct >= 80 ? 'text-bad' : fill.pct >= 60 ? 'text-yellow-700' : 'text-ink-700';
              return (
                <div key={fill.code} className="flex items-center gap-2">
                  <span className="w-14 shrink-0 font-mono text-sm font-extrabold">{fill.code}</span>
                  <div className="h-3 min-w-0 flex-1 overflow-hidden rounded bg-surface-sunken">
                    <div className={`h-full ${color}`} style={{ width: `${Math.min(100, fill.pct)}%` }} />
                  </div>
                  <span className={`w-32 shrink-0 text-right font-mono text-xs font-bold ${text}`}>
                    {fill.occupiedM3}/{fill.capacityM3} m³ · {fill.pct}%
                  </span>
                  {fill.pct >= 80 && <span title={t('fillShipHint')}>🚨</span>}
                </div>
              );
            })}
          </div>
        )}

        <div className="card space-y-1 !p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            📦 {t('stock')}
          </p>
          {stock.map((row) => (
            <div key={row.code} className="flex items-baseline gap-2 text-sm">
              <span className="w-14 font-mono font-extrabold">{row.code}</span>
              <span className="font-semibold">{row.boxCount} 📦</span>
              <span className="ml-auto font-mono text-xs text-ink-700">
                {row.kg} kg · {row.m3} m³
              </span>
            </div>
          ))}
          {stock.length === 0 && <p className="text-sm text-ink-500">—</p>}
        </div>

        <div className="card space-y-1 !p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            🚛 {t('inTransit')}
          </p>
          {transit.map((batch) => (
            <Link
              key={batch.id}
              href={`/batches/${batch.id}`}
              className="flex items-baseline gap-2 text-sm hover:bg-surface-sunken"
            >
              <span className="font-mono font-extrabold text-brand-700">{batch.code}</span>
              <span className="font-mono text-xs">{batch.originCode}→{batch.destCode}</span>
              <span className="text-ink-700">{batch.boxCount} 📦</span>
              {batch.departedAt && (
                <span className="ml-auto text-xs text-ink-500">
                  {format.dateTime(batch.departedAt, { dateStyle: 'short' })}
                </span>
              )}
            </Link>
          ))}
          {transit.length === 0 && <p className="text-sm text-ink-500">—</p>}
        </div>

        <div className="card space-y-1 !p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            📥 {t('receipts24h')}
          </p>
          {receipts24.map((row) => (
            <div key={row.code} className="flex items-baseline gap-2 text-sm">
              <span className="w-14 font-mono font-extrabold">{row.code}</span>
              <span className="font-semibold">{row.n}</span>
            </div>
          ))}
          {receipts24.length === 0 && <p className="text-sm text-ink-500">—</p>}
        </div>

        <div className="card space-y-2 !p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            ⚠️ {t('attention')}
          </p>
          <Link href="/unclaimed" className="flex items-baseline gap-2 text-sm">
            <span>❓ {t('unclaimed')}</span>
            <span className="ml-auto font-bold">
              {unclaimed.receipts} / {unclaimed.boxes} 📦
            </span>
          </Link>
          {aging.map((row) => (
            <div key={row.code} className="flex items-baseline gap-2 text-sm">
              <span>
                🕰 {t('aging', { days: staleDays })} · <b className="font-mono">{row.code}</b>
              </span>
              <span className="ml-auto font-bold text-warn">
                {row.n} 📦 (max {row.worstDays} {t('days')})
              </span>
            </div>
          ))}
          <Link href="/transit" className="flex items-baseline gap-2 text-sm">
            <span>🚨 {t('missingInTransit')}</span>
            <span className={`ml-auto font-bold ${flags.missing > 0 ? 'text-bad' : ''}`}>
              {flags.missing}
            </span>
          </Link>
          <div className="flex items-baseline gap-2 text-sm">
            <span>🌀 {t('undocumented')}</span>
            <span className={`ml-auto font-bold ${flags.undocumented > 0 ? 'text-warn' : ''}`}>
              {flags.undocumented}
            </span>
          </div>
          {costMissing.length > 0 && (
            <div className="space-y-1 border-t border-line pt-2 text-sm">
              <p className="font-semibold text-warn">💸 {t('costMissing')}</p>
              {costMissing.map((batch) => (
                <Link key={batch.id} href={`/batches/${batch.id}`} className="flex gap-2 text-xs">
                  <span className="font-mono font-bold text-brand-700">{batch.code}</span>
                  <span className="font-mono">{batch.originCode}→{batch.destCode}</span>
                  {batch.departedAt && (
                    <span className="ml-auto text-ink-500">
                      {format.dateTime(batch.departedAt, { dateStyle: 'short' })}
                    </span>
                  )}
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
