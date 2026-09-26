import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import {
  loadCostMissing,
  loadFill,
  loadPipeline,
  loadToday,
  loadTransit,
  loadWindows,
} from '@/modules/wms/reports/dashboard';
import { daysSince } from '@/modules/wms/reports/dashboard-math';
import { StackBar } from '@/components/charts/stack-bar';
import { SERIES_BG, type SeriesKey } from '@/components/charts/legend';
import { tipText } from '@/components/charts/tip-text';
import { m3, num } from '@/components/charts/format';
import { WarehouseFillRows } from '@/components/warehouse-fill';

/**
 * «Yuk» (spec «D»): where the cargo stands right now — China, the road,
 * Uzbekistan — which trucks are on the road or standing at the gate, how
 * full and how stale each warehouse is, and the trucks that left with no
 * cost typed. The warehouse people read this section too, so nothing here
 * carries money.
 */
export async function CargoSection({
  scopeKey,
  staleDays,
  seesBatches,
  seesCostMissing,
  canEditCapacity,
}: {
  scopeKey: string;
  staleDays: number;
  seesBatches: boolean;
  seesCostMissing: boolean;
  canEditCapacity: boolean;
}) {
  const t = await getTranslations('dashboard');
  const format = await getFormatter();
  const w = loadWindows();
  const [pipeline, transit, fills, today, costMissing] = await Promise.all([
    loadPipeline(scopeKey),
    seesBatches ? loadTransit(scopeKey) : null,
    loadFill(scopeKey, staleDays),
    loadToday(scopeKey),
    seesCostMissing ? loadCostMissing(scopeKey) : null,
  ]);

  const stages: { key: 'cn' | 'road' | 'uz' | 'other'; series: SeriesKey; label: string; href: string }[] = [
    { key: 'cn', series: 'ord1', label: t('stageCn'), href: '/stock' },
    ...(seesBatches ? [{ key: 'road' as const, series: 'ord2' as const, label: t('stageRoad'), href: '/transit' }] : []),
    { key: 'uz', series: 'ord3', label: t('stageUz'), href: '/stock' },
    ...(pipeline.other.boxes > 0
      ? [{ key: 'other' as const, series: 'muted' as const, label: t('stageOther'), href: '/stock' }]
      : []),
  ];
  const totalM3 = stages.reduce((sum, stage) => sum + pipeline[stage.key].m3, 0);
  const totalBoxes = stages.reduce((sum, stage) => sum + pipeline[stage.key].boxes, 0);
  const days = (from: Date | string | null) => daysSince(from, w.today);

  return (
    <section data-testid="section-logisticsTitle" className="space-y-3">
      <p className="section-title">📦 {t('logisticsTitle')}</p>

      {/* What happened since midnight — the warehouses' own morning numbers. */}
      <div className="card grid grid-cols-4 gap-2 text-center" data-testid="dash-today">
        <TodayCell label={t('todayReceipts')} value={today.receipts} />
        <TodayCell label={t('todayDeparted')} value={today.departed} />
        <TodayCell label={t('todayArrived')} value={today.arrived} />
        <TodayCell
          label={t('todayExpected')}
          value={today.expectedToday}
          hint={today.expectedLate > 0 ? t('lateCount', { n: today.expectedLate }) : undefined}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* D1 — the journey, as one bar. */}
        <div className="card min-w-0 space-y-2" data-testid="dash-pipeline">
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-semibold">{t('pipelineTitle')}</p>
            <Link href="/stock" className="shrink-0 font-mono text-xs font-semibold text-brand-700">
              {m3(totalM3)} m³ · {num(totalBoxes)} 📦
            </Link>
          </div>
          <StackBar
            testid="dash-pipeline-bar"
            parts={stages.map((stage) => ({
              key: stage.series,
              value: pipeline[stage.key].m3,
              tip: tipText(stage.label, [
                [`${m3(pipeline[stage.key].m3)} m³`, ''],
                [`${num(pipeline[stage.key].boxes)} 📦`, ''],
              ]),
            }))}
          />
          <ul className="space-y-1 text-xs">
            {stages.map((stage) => (
              <li key={stage.key} data-testid={`pipeline-${stage.key}`}>
                <Link href={stage.href} className="flex items-center gap-2 rounded hover:bg-surface-sunken">
                  <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-sm ${SERIES_BG[stage.series]}`} />
                  <span className="min-w-0 flex-1 break-words">
                    {stage.label}
                    {stage.key === 'road' && transit && transit.length > 0 && (
                      <span className="text-ink-500"> · {t('trucks', { n: transit.length })}</span>
                    )}
                  </span>
                  <span className="whitespace-nowrap font-mono tabular-nums">{m3(pipeline[stage.key].m3)} m³</span>
                  <span className="w-16 whitespace-nowrap text-right font-mono tabular-nums text-ink-500">
                    {num(pipeline[stage.key].boxes)} 📦
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="text-2xs text-ink-500">{t('pipelineNote')}</p>
        </div>

        {/* D2 — trucks on the road or standing at the gate. */}
        {transit && (
          <div className="card min-w-0 space-y-2" data-testid="dash-transit">
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-semibold">🚛 {t('inTransit')}</p>
              <Link href="/transit" className="shrink-0 text-xs font-semibold text-brand-700">
                {t('allOf', { n: transit.length })} →
              </Link>
            </div>
            <ul className="divide-y divide-line">
              {transit.slice(0, 5).map((batch) => {
                const arrived = batch.status === 'arrived';
                const n = arrived ? days(batch.arrivedAt) : days(batch.departedAt);
                const late = arrived ? n >= 2 : n > 10;
                return (
                  <li key={batch.id}>
                    <Link href={`/batches/${batch.id}`} className="block py-1.5 hover:bg-surface-sunken">
                      <div className="flex items-baseline gap-2 text-sm">
                        <span className="font-mono font-bold text-brand-700">{batch.code}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-500">
                          {batch.originCode}→{batch.destCode}
                        </span>
                        <span className="whitespace-nowrap text-xs">{num(batch.boxCount)} 📦</span>
                      </div>
                      <div className="mt-0.5 flex items-baseline gap-2 text-2xs text-ink-500">
                        {batch.departedAt && <span>{format.dateTime(batch.departedAt, { dateStyle: 'short' })}</span>}
                        <span className={`ml-auto ${late ? 'chip-warn' : 'chip-neutral'}`}>
                          {arrived ? t('arrivedDays', { n }) : t('roadDays', { n })}
                        </span>
                      </div>
                    </Link>
                  </li>
                );
              })}
              {transit.length === 0 && <li className="py-1.5 text-sm text-ink-500">{t('noTrucks')}</li>}
            </ul>
          </div>
        )}
      </div>

      {/* D3 — how full and how stale each warehouse is. */}
      {fills.length > 0 && (
        <div className="card space-y-2" data-testid="dash-fill">
          <p className="font-semibold">{t('fill')}</p>
          {/* One component, both screens — the owner's home draws the
              identical rows (#513: two copies of a bar disagree about what a
              missing capacity means). */}
          <WarehouseFillRows rows={fills} staleDays={staleDays} canEditCapacity={canEditCapacity} />
        </div>
      )}

      {/* D4 — trucks that left more than three days ago with no cost typed. */}
      {costMissing && costMissing.count > 0 && (
        <details id="xarajatsiz" open className="card scroll-mt-20" data-testid="dash-cost-missing">
          <summary className="cursor-pointer font-semibold text-warn">
            💸 {t('costMissing')}{' '}
            <span className="font-mono text-ink-500">({costMissing.count})</span>
          </summary>
          {costMissing.count > costMissing.rows.length && (
            <p className="mt-1 text-2xs text-ink-500">
              {t('oldestOf', { shown: costMissing.rows.length, total: costMissing.count })}
            </p>
          )}
          <ul className="mt-2 space-y-1">
            {costMissing.rows.map((batch) => (
              <li key={batch.id}>
                <Link href={`/batches/${batch.id}`} className="flex gap-2 text-xs hover:bg-surface-sunken">
                  <span className="font-mono font-bold text-brand-700">{batch.code}</span>
                  <span className="font-mono">
                    {batch.originCode}→{batch.destCode}
                  </span>
                  {batch.departedAt && (
                    <span className="ml-auto text-ink-500">
                      {format.dateTime(batch.departedAt, { dateStyle: 'short' })}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function TodayCell({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="min-w-0">
      <p className={`font-mono text-xl font-extrabold tabular-nums ${hint ? 'text-warn' : ''}`}>{value}</p>
      <p className="truncate text-2xs text-ink-500">{label}</p>
      {hint && <p className="truncate text-2xs font-semibold text-warn">{hint}</p>}
    </div>
  );
}
