import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { pnlGaps, profitAndLoss, type FxPnlKey, type PnlRow } from '@/modules/wms/accounting/reports';
import { priorPeriod, resolvePeriod, toUzs, uzsRate } from '@/modules/wms/accounting/period';
import { niceTicks, pctDelta, pnlMonthParts } from '@/modules/wms/reports/dashboard-math';
import { marginPct } from '@/modules/wms/accounting/margin';
import { ColumnPairs } from '@/components/charts/column-pairs';
import { Legend } from '@/components/charts/legend';
import { tipText } from '@/components/charts/tip-text';
import { monthLabel, monthNames } from '@/components/charts/month-names';
import { compactUsd, pct, signedUsd } from '@/components/charts/format';
import { perUsd } from '@/modules/wms/costing/fx-display';
import { PeriodForm } from '../period-form';
import { PnlGapsNote } from '../pnl-gaps';
import { PnlLossesNote } from '../pnl-losses';
import { lossesInPeriod } from '@/modules/wms/reports/business';
import { PageHeader } from '@/components/ui/page';
import { mayClassifyFx } from '@/modules/wms/finance/fx-door';
import { legacyFxCount } from '@/modules/wms/finance/fx-legacy';
import { maySeeStaffMoney } from '@/modules/wms/partners/staff';

/**
 * P&L: the answer first, then the months, then every line (the owner's item
 * 10, 2026-09-26): five headline figures with their change against the
 * period before (`priorPeriod` — last year's same days for a year to date,
 * last month's for a month to date), the month-by-month picture in the
 * dashboard's own chart grammar, and the full table folded underneath. Every
 * figure is the table's own total — nothing here is computed twice.
 *
 * P&L, one column per month.
 *
 * The note under the table is not decoration: revenue and cargo costs each
 * land on their own date, so a batch priced the month after it shipped
 * straddles two columns. Anyone reading a single month's gross margin needs
 * to know that, and "Profit by batch" is where the period-free answer lives.
 */
export default async function PnlPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.reports')) redirect('/accounting');
  const t = await getTranslations('accounting');
  const { from, to } = resolvePeriod(await searchParams);
  // The legacy kurs farqi residues (0103) are the classifier's to close, so
  // the walk is paid only on that person's P&L (fence F8).
  const mayOpenFx = mayClassifyFx(actor.permissions);
  const prior = priorPeriod(from, to);
  const td = await getTranslations('dashboard');
  const [pnl, rate, gaps, losses, legacyFx, before, names] = await Promise.all([
    profitAndLoss(from, to),
    uzsRate(),
    pnlGaps(from, to),
    lossesInPeriod(from, to),
    mayOpenFx ? legacyFxCount({ includeStaff: maySeeStaffMoney(actor.permissions) }) : Promise.resolve(null),
    profitAndLoss(prior.from, prior.to),
    monthNames(),
  ]);

  const usd = (value: number) =>
    value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const uzs = (value: number) => {
    const converted = toUzs(value, rate);
    return converted === null ? '' : converted.toLocaleString('en-US');
  };

  // ── The five headline figures and their change ──────────────────────────
  const kpis = [
    { key: 'revenue', label: t('revenue'), now: pnl.revenue.total, was: before.revenue.total, up: 'good' },
    { key: 'direct', label: t('directCosts'), now: pnl.directTotal.total, was: before.directTotal.total, up: 'bad' },
    { key: 'gross', label: t('grossProfit'), now: pnl.grossProfit.total, was: before.grossProfit.total, up: 'good' },
    { key: 'opex', label: t('opex'), now: pnl.opexTotal.total, was: before.opexTotal.total, up: 'bad' },
    { key: 'net', label: t('netProfit'), now: pnl.netProfit.total, was: before.netProfit.total, up: 'good' },
  ] as const;
  const grossMargin = marginPct(pnl.grossProfit.total, pnl.revenue.total);
  const netMargin = marginPct(pnl.netProfit.total, pnl.revenue.total);

  // ── The months, in the dashboard's grammar (one scale, net underneath) ──
  const parts = pnl.months.map((month) => pnlMonthParts(pnl, month));
  const revenueByMonth = parts.map((p) => p.revenue);
  const costByMonth = parts.map((p) => p.cost);
  const netByMonth = parts.map((p) => p.net);
  const { ticks, top } = niceTicks(Math.max(1, ...revenueByMonth, ...costByMonth));
  const netMax = Math.max(1, ...netByMonth.map(Math.abs));
  const lastMonth = pnl.months.length - 1;
  const bands = pnl.months.map((month) => ({ key: month, label: monthLabel(names, month) }));
  const labelled = new Set(pnl.months.map((_, i) => i).filter((i) => (lastMonth - i) % 3 === 0));
  const tips = pnl.months.map((month, i) =>
    tipText(monthLabel(names, month, true), [
      [`$${usd(parts[i]!.revenue)}`, td('sRevenue')],
      [`$${usd(parts[i]!.direct)}`, td('sDirect')],
      [`$${usd(parts[i]!.opex)}`, td('sOpex')],
      ...(Math.abs(parts[i]!.fx) > 0.004 ? [[signedUsd(parts[i]!.fx), td('sFx')] as [string, string]] : []),
      [signedUsd(parts[i]!.net), td('sNet')],
    ]),
  );

  // The kurs farqi sources (0103) — a literal map, so a new source is a type
  // error and not a key built at render (#163).
  const FX_LABEL: Record<FxPnlKey, string> = {
    'fx:kassa': t('fxKassa'),
    'fx:settlement': t('fxSettlement'),
    'fx:adjust': t('fxAdjust'),
    'fx:closing': t('fxClosing'),
  };

  const line = (row: PnlRow, label: string, className = '', testId?: string) => (
    <tr key={row.key} className={`border-b border-line ${className}`} data-testid={testId}>
      <td className="sticky left-0 z-10 bg-inherit p-2">{label}</td>
      {pnl.months.map((month) => (
        <td key={month} className="p-2 text-right font-mono">
          {usd(row.byPeriod[month] ?? 0)}
        </td>
      ))}
      <td className="p-2 text-right font-mono font-bold">{usd(row.total)}</td>
      <td className="p-2 text-right font-mono text-ink-500">{uzs(row.total)}</td>
    </tr>
  );

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-5xl">
      <PageHeader icon="chart" title={t('pnl')} />
      <PeriodForm from={from} to={to} exportHref="/api/accounting/pnl" />
      <PnlGapsNote gaps={gaps} legacyFx={legacyFx} mayOpenFx={mayOpenFx} />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" data-testid="pnl-kpis">
        {kpis.map((kpi) => {
          // The dashboard's ONE delta rule (O4): a percentage only over a
          // positive base, to 0.1 — the tile that links here prints the same.
          // Against a loss the sign of a percentage lies, so the difference is
          // printed in dollars; against nothing at all, the words say so.
          const delta = pctDelta(kpi.now, kpi.was);
          const diff = kpi.now - kpi.was;
          const nothingBefore = Math.abs(kpi.was) < 0.005;
          const moved = delta ?? (nothingBefore ? null : diff);
          const good = moved !== null && (kpi.up === 'good' ? moved > 0 : moved < 0);
          const tone =
            kpi.key === 'net'
              ? kpi.now >= 0
                ? 'text-good'
                : 'text-bad'
              : 'text-ink-900';
          return (
            <div
              key={kpi.key}
              className={`card min-w-0 !p-3 ${kpi.key === 'net' ? 'col-span-2 sm:col-span-1' : ''}`}
              data-testid={`pnl-kpi-${kpi.key}`}
            >
              <p className="text-2xs font-semibold uppercase leading-tight tracking-wide text-ink-500">
                {kpi.label}
              </p>
              <p className={`mt-0.5 whitespace-nowrap font-mono text-xl font-bold tabular-nums ${tone}`}>
                {compactUsd(kpi.now)}
              </p>
              {(kpi.key === 'gross' || kpi.key === 'net') && (
                <p className="text-2xs text-ink-500">
                  {t('pnlMarginShort')}{' '}
                  {(kpi.key === 'gross' ? grossMargin : netMargin) === null
                    ? '—'
                    : pct((kpi.key === 'gross' ? grossMargin : netMargin)!)}
                </p>
              )}
              <p
                className={`text-2xs font-semibold ${moved === null ? 'text-ink-500' : good ? 'text-good' : 'text-bad'}`}
              >
                {moved === null
                  ? `— ${t('pnlVsPriorNone')}`
                  : `${moved > 0 ? '▲' : moved < 0 ? '▼' : '='} ${
                      delta === null ? `${diff > 0 ? '+' : ''}${compactUsd(diff)}` : pct(Math.abs(delta))
                    } · ${compactUsd(kpi.was)}`}
              </p>
            </div>
          );
        })}
      </div>
      <p className="text-2xs text-ink-500" data-testid="pnl-prior">
        {t('pnlVsPrior', { from: prior.from, to: prior.to })}
      </p>

      {pnl.months.length > 1 && (
        <div className="card min-w-0 space-y-2" data-testid="pnl-chart-card">
          <p className="font-semibold">{t('pnlByMonth')}</p>
          <Legend
            items={[
              { key: 'in', label: td('sRevenue') },
              { key: 'out', label: td('sCost') },
            ]}
          />
          <ColumnPairs
            months={bands}
            a={{ values: revenueByMonth }}
            b={{ values: costByMonth }}
            net={netByMonth}
            top={top}
            ticks={ticks}
            netMax={netMax}
            tips={tips}
            labelled={labelled}
            netLabel={td('sNet')}
            testid="pnl-chart"
          />
        </div>
      )}

      <details className="card !p-0" data-testid="pnl-detail">
        <summary className="cursor-pointer p-3 text-sm font-semibold text-ink-700" data-testid="pnl-detail-toggle">
          📋 {t('pnlDetail')}
        </summary>
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-line-strong bg-surface-sunken text-left text-xs uppercase text-ink-500">
                <th className="sticky left-0 z-10 bg-surface-sunken p-2">{t('category')}</th>
                {pnl.months.map((month) => (
                  <th key={month} className="p-2 text-right">
                    {month}
                  </th>
                ))}
                <th className="p-2 text-right">{t('total')} $</th>
                <th className="p-2 text-right">UZS</th>
              </tr>
            </thead>
            <tbody>
              {/* Compensation for lost cargo (0105): the file's own «— rows sum
                  into the bold line that follows» convention, so gross −
                  compensation = the net revenue adds up by eye (U22). */}
              {pnl.compensation.total !== 0 &&
                line(pnl.grossCharges, `— ${t('pnlGrossCharges')}`, 'text-ink-700', 'pnl-gross-charges')}
              {pnl.compensation.total !== 0 &&
                line(
                  { ...pnl.compensation, byPeriod: Object.fromEntries(Object.entries(pnl.compensation.byPeriod).map(([k, v]) => [k, -v])), total: -pnl.compensation.total },
                  `— ${t('pnlCompensation')}`,
                  'text-ink-700',
                  'pnl-compensation',
                )}
              {line(pnl.revenue, t('revenue'), 'bg-good/10 font-semibold')}
              {pnl.directCosts.map((row) => line(row, `— ${row.label}`, 'text-ink-700'))}
              {line(pnl.directTotal, t('directCosts'), 'font-semibold')}
              <tr className="border-b-2 border-line-strong bg-brand-50 font-bold">
                <td className="sticky left-0 z-10 bg-brand-50 p-2">{t('grossProfit')}</td>
                {pnl.months.map((month) => (
                  <td key={month} className="p-2 text-right font-mono">
                    {usd(pnl.grossProfit.byPeriod[month] ?? 0)}
                    <span className="ml-1 text-xs font-normal text-ink-500">
                      {/* No margin over revenue that is not positive (0105). */}
                      {pnl.grossMarginPct[month] === null || pnl.grossMarginPct[month] === undefined
                        ? '—'
                        : `${pnl.grossMarginPct[month]}%`}
                    </span>
                  </td>
                ))}
                <td className="p-2 text-right font-mono">{usd(pnl.grossProfit.total)}</td>
                <td className="p-2 text-right font-mono text-ink-700">
                  {uzs(pnl.grossProfit.total)}
                </td>
              </tr>
              {pnl.opex.map((row) => line(row, `— ${row.label}`, 'text-ink-700'))}
              {line(pnl.opexTotal, t('opex'), 'font-semibold')}
              {/* «Kurs farqi» (the owner's Q12 A): after the overheads and
                  before the net, which includes it. */}
              {line(pnl.fxTotal, t('fxTotal'), 'font-semibold', 'pnl-fx')}
              {pnl.fx.map((row) => line(row, `— ${FX_LABEL[row.key as FxPnlKey]}`, 'text-ink-700'))}
              <tr
                className={`border-t-2 border-line-strong font-bold ${
                  pnl.netProfit.total >= 0 ? 'bg-good/15' : 'bg-bad/15'
                }`}
              >
                <td className="sticky left-0 z-10 bg-inherit p-2">{t('netProfit')}</td>
                {pnl.months.map((month) => (
                  <td key={month} className="p-2 text-right font-mono">
                    {usd(pnl.netProfit.byPeriod[month] ?? 0)}
                  </td>
                ))}
                <td className="p-2 text-right font-mono">{usd(pnl.netProfit.total)}</td>
                <td className="p-2 text-right font-mono text-ink-700">
                  {uzs(pnl.netProfit.total)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>

      <PnlLossesNote losses={losses} />

      <p className="text-xs text-ink-500">ℹ️ {t('pnlNote')}</p>
      <p className="text-xs text-ink-500" data-testid="pnl-fx-note">
        ℹ️ {t('fxNote')}
      </p>
      {rate && (
        <p className="text-xs text-ink-400">
          {/* The stored rate is dollars per ONE so'm; the reader quotes so'm per dollar. */}
          {t('uzsNote', { rate: `1 $ = ${(perUsd(rate) ?? 0).toLocaleString('en-US')} UZS` })}
        </p>
      )}
    </div>
  );
}
