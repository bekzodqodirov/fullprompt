import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { formatEtaRange } from '@/modules/platform/telegram/client-labels';
import {
  loadCostMissing,
  loadFill,
  loadIntakeDays,
  loadPipeline,
  loadToday,
  loadTrucks,
  loadWindows,
} from '@/modules/wms/reports/dashboard';
import { niceTicks } from '@/modules/wms/reports/dashboard-math';
import type { TruckKind, TruckRow } from '@/modules/wms/tracking/on-road-state';
import { StackBar } from '@/components/charts/stack-bar';
import { SERIES_BG, type SeriesKey } from '@/components/charts/legend';
import { tipText } from '@/components/charts/tip-text';
import { DayColumns } from '@/components/charts/day-columns';
import { MeterRow } from '@/components/charts/meter-row';
import { ScopeTag } from '@/components/charts/scope-tag';
import { TableTwin } from '@/components/charts/table-twin';
import { dayLabel, monthNames } from '@/components/charts/month-names';
import { m3, num } from '@/components/charts/format';
import { WarehouseFillRows } from '@/components/warehouse-fill';

/**
 * «Yuk» under «Batafsil» (spec «D»): what happened since midnight, where the
 * cargo stands right now — China, the road, Uzbekistan — and the trucks that
 * left with no cost typed. The trucks and the warehouses' fill moved to the
 * top of the page as their own cards (round B). The warehouse people read
 * this section too, so nothing here carries money.
 */
export async function CargoSection({
  scopeKey,
  seesBatches,
  seesCostMissing,
}: {
  scopeKey: string;
  seesBatches: boolean;
  seesCostMissing: boolean;
}) {
  const t = await getTranslations('dashboard');
  const format = await getFormatter();
  const [pipeline, trucks, today, costMissing] = await Promise.all([
    loadPipeline(scopeKey),
    seesBatches ? loadTrucks(scopeKey) : null,
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

  return (
    <section data-testid="section-logisticsTitle" className="space-y-3">
      <p className="section-title">📦 {t('logisticsTitle')}</p>

      {/* What happened since midnight — the warehouses' own morning numbers. */}
      {/* The two truck cells only for a viewer who may open a truck (O26). */}
      <div
        className={`card grid gap-2 text-center ${seesBatches ? 'grid-cols-4' : 'grid-cols-2'}`}
        data-testid="dash-today"
      >
        <TodayCell label={t('todayReceipts')} value={today.receipts} />
        {seesBatches && <TodayCell label={t('todayDeparted')} value={today.departed} />}
        {seesBatches && <TodayCell label={t('todayArrived')} value={today.arrived} />}
        <TodayCell
          label={t('todayExpected')}
          value={today.expectedToday}
          hint={today.expectedLate > 0 ? t('lateCount', { n: today.expectedLate }) : undefined}
        />
      </div>

      <div>
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
                    {stage.key === 'road' && trucks && trucks.total > 0 && (
                      <span className="text-ink-500"> · {t('trucks', { n: trucks.total })}</span>
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
      </div>

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

/** «27.09» in Tashkent — an estimate is always days away, so no year (formatEtaRange's rule). */
const etaDay = (iso: string) => formatEtaRange(iso, iso);

/**
 * «Qabul qilingan yuk — kunlar bo'yicha» (the canvas's intake card): thirty
 * Tashkent days of cubic metres, today last. Past days in a mid step of the
 * ordinal ramp and today in the darkest — the lightest step is 2.11:1 on the
 * card, under the 3:1 a mark standing alone needs. The average is over the
 * CLOSED days: today is still being received, and folding a morning into the
 * mean makes every morning look like a slow month.
 */
export async function IntakeDaysCard({ scopeKey, ombor }: { scopeKey: string; ombor: string | null }) {
  const t = await getTranslations('dashboard');
  const names = await monthNames();
  const w = loadWindows();
  const intake = await loadIntakeDays(scopeKey);
  const days = intake.days;
  const values = days.map((day) => day.m3);
  const last = days.length - 1;
  const closed = values.slice(0, Math.max(0, last));
  const closedM3 = closed.reduce((sum, value) => sum + value, 0);
  const avg = closed.length > 0 ? closedM3 / closed.length : 0;
  const { ticks, top } = niceTicks(Math.max(1, ...values));
  const labelled = new Set(days.map((_, i) => i).filter((i) => (last - i) % 7 === 0));
  const tips = days.map((day) =>
    tipText(dayLabel(names, day.day), [
      [`${m3(day.m3)} m³`, ''],
      [num(day.receipts), t('sReceipts')],
      [num(day.boxes), t('sBoxes')],
    ]),
  );
  const most = intake.byWarehouse
    .filter((row) => row.m3 > 0.0005)
    .slice(0, 3)
    .map((row) => `${row.code} ${m3(row.m3)} m³`)
    .join(' · ');
  const journal = `/reports/receipts-journal?from=${w.d30Start}&to=${w.today}${ombor ? `&ombor=${ombor}` : ''}`;

  return (
    <div className="card min-w-0 space-y-2" data-testid="dash-intake-days">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="font-semibold">{t('daysTitle')}</p>
        <ScopeTag label={t('scope.d30')} />
        <Link
          href={journal}
          className="ml-auto shrink-0 font-mono text-xs font-semibold text-brand-700"
          data-testid="dash-intake-days-total"
        >
          <span data-value={String(intake.total.m3)}>{m3(intake.total.m3)} m³</span> →
        </Link>
      </div>
      <DayColumns
        days={days.map((day) => ({ key: day.day, label: dayLabel(names, day.day) }))}
        values={values}
        todayIndex={last >= 0 ? last : null}
        top={top}
        ticks={ticks}
        tips={tips}
        labelled={labelled}
        todayLabel={t('daysToday', { m3: m3(values[last] ?? 0) })}
        testid="dash-intake-days-chart"
      />
      <p className="text-xs text-ink-700">
        {t('daysSummary', { days: closed.length, m3: m3(closedM3), avg: m3(avg) })}
      </p>
      {most && <p className="text-2xs text-ink-500">{t('daysShare', { list: most })}</p>}
      <TableTwin
        summary={t('table')}
        testid="dash-intake-days-table"
        head={['', 'm³', t('sReceipts'), t('sBoxes')]}
        rows={[...days].reverse().map((day) => [dayLabel(names, day.day), m3(day.m3), num(day.receipts), num(day.boxes)])}
      />
    </div>
  );
}

// Literal maps — Tailwind compiles only what it can see, and a word built
// from a key escapes the i18n tripwire (#163).
const TRUCK_BAR: Record<TruckKind, string> = {
  stuck: 'bg-warn',
  overdue: 'bg-warn',
  unloading: 'bg-viz-in',
  on_road: 'bg-viz-in',
  no_schedule: 'bg-ink-400',
};
const TRUCK_CHIP: Record<TruckKind, string> = {
  stuck: 'chip-warn',
  overdue: 'chip-warn',
  unloading: 'chip-neutral',
  on_road: 'chip-neutral',
  no_schedule: 'chip-neutral',
};

/**
 * «Yo'ldagi mashinalar» — the trucks that need a look first (standing at the
 * gate unloaded, past their schedule), then the ones on their way, nearest
 * arrival first (`rankTrucks`). The bar is the SCHEDULE's progress — his own
 * per-route hours (`map-data.ts`), re-anchored by the last pin — and says
 * «taxminan» beside it; a truck with no modelled road gets no bar and no date
 * rather than an invented one (judge O14), and a date only on a MOVING rung,
 * the customer's cabinet's own rule (O15). The box count is what DEPARTED on
 * the truck, labelled as such (O18).
 */
export async function TrucksCard({ scopeKey }: { scopeKey: string }) {
  const t = await getTranslations('dashboard');
  const tb = await getTranslations('batches');
  const tm = await getTranslations('map');
  const trucks = await loadTrucks(scopeKey);
  const STAGE: Record<NonNullable<TruckRow['stage']>, string> = {
    cn_transit: t('truckStage.cn_transit'),
    export_transit: t('truckStage.export_transit'),
    in_uz: t('truckStage.in_uz'),
    customs_done: t('truckStage.customs_done'),
  };
  const PIN: Record<string, string> = { at_border: tb('cpBorder'), in_kg: tb('cpKg'), in_uz: tb('cpUz') };

  const word = (row: TruckRow) =>
    row.kind === 'stuck'
      ? t('truckKind.stuck')
      : row.kind === 'unloading'
        ? t('truckKind.unloading')
        : row.stage
          ? STAGE[row.stage]
          : t('truckStage.export_transit');
  const sub = (row: TruckRow) => {
    const parts: React.ReactNode[] = [];
    if (row.status === 'arrived') {
      parts.push(t('arrivedDays', { n: row.days }));
      if ((row.awaitingUnload ?? 0) > 0) parts.push(t('truckGate', { n: num(row.awaitingUnload ?? 0) }));
    } else {
      parts.push(t('roadDays', { n: row.days }));
      if (row.kind === 'overdue') {
        parts.push(
          <span key="late" className="font-semibold text-warn">
            {tm('overdue')}
          </span>,
        );
      } else if (row.eta) {
        parts.push(`${t('truckEta', { from: etaDay(row.eta.fromIso), to: etaDay(row.eta.toIso) })} (${t('truckEstimate')})`);
      } else if (row.kind === 'no_schedule') {
        parts.push(t('truckNoRoute'));
      }
      if (row.checkpoint && PIN[row.checkpoint.key]) {
        parts.push(`${PIN[row.checkpoint.key]} · ${t('truckPin', { n: row.pinDays ?? 0 })}`);
      }
      parts.push(t('truckDeparted', { n: num(row.departedBoxes) }));
    }
    return parts.map((part, i) => (
      <span key={i}>
        {i > 0 && ' · '}
        {part}
      </span>
    ));
  };

  return (
    <div className="card min-w-0 space-y-2" data-testid="dash-trucks">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="font-semibold">🚛 {t('trucksTitle')}</p>
        <span className="font-mono text-sm font-bold tabular-nums">{trucks.total}</span>
        <ScopeTag label={t('scope.now')} />
        <Link href="/map" className="ml-auto shrink-0 text-xs font-semibold text-brand-700">
          {t('toMap')} →
        </Link>
      </div>
      {trucks.rows.length === 0 ? (
        <p className="text-sm text-ink-500">{t('noTrucks')}</p>
      ) : (
        <ul className="space-y-2.5">
          {trucks.rows.map((row) => (
            <li key={row.id}>
              <MeterRow
                href={`/batches/${row.id}`}
                testid="dash-truck-row"
                label={
                  <>
                    <span className="font-mono font-bold text-brand-700">{row.code}</span>{' '}
                    <span className="text-ink-500">
                      {row.originName} → {row.destName}
                    </span>
                  </>
                }
                value={<span className={`${TRUCK_CHIP[row.kind]} whitespace-nowrap`}>{word(row)}</span>}
                pct={row.roadPct}
                barClass={TRUCK_BAR[row.kind]}
                sub={sub(row)}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-2 text-xs">
        {trucks.loading > 0 && (
          <Link href="/batches" className="font-semibold text-brand-700" data-testid="dash-trucks-loading">
            {t('truckLoading', { n: trucks.loading })} →
          </Link>
        )}
        {trucks.total > trucks.rows.length && (
          <Link href="/transit" className="font-semibold text-brand-700">
            {t('truckMore', { n: trucks.total - trucks.rows.length })} →
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * How full and how stale each warehouse is — the SAME rows the owner's home
 * draws (#513), stacked here because a quarter-width card has no room for a
 * bar beside a code, a value and an age on one line.
 */
export async function FillCard({
  scopeKey,
  staleDays,
  canEditCapacity,
}: {
  scopeKey: string;
  staleDays: number;
  canEditCapacity: boolean;
}) {
  const t = await getTranslations('dashboard');
  const fills = await loadFill(scopeKey, staleDays);
  if (fills.length === 0) return null;
  return (
    <div className="card min-w-0 space-y-2" data-testid="dash-fill">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="font-semibold">{t('fill')}</p>
        <ScopeTag label={t('scope.now')} />
      </div>
      {/* One component, both screens — the owner's home draws the identical
          rows (#513: two copies of a bar disagree about what a missing
          capacity means). */}
      <WarehouseFillRows rows={fills} staleDays={staleDays} canEditCapacity={canEditCapacity} layout="stacked" />
    </div>
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
