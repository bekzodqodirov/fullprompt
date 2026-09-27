import { Suspense } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { CompanyMoneySight } from '@/modules/wms/finance/scope';
import {
  loadAging,
  loadBalance,
  loadBalanceParts,
  loadCashRange,
  loadIntakeRange,
  loadPipeline,
  loadPnl12,
  loadPnlRange,
  loadTargetFor,
  loadTrucks,
} from '@/modules/wms/reports/dashboard';
import {
  pctDelta,
  planPace,
  planProgress,
  pnlParts,
  signedTicks,
  type DashPeriod,
  type DashPeriodKey,
} from '@/modules/wms/reports/dashboard-math';
import { marginPct } from '@/modules/wms/accounting/margin';
import { StatTile } from '@/components/charts/stat-tile';
import { Sparkline } from '@/components/charts/sparkline';
import { PlanMeter } from '@/components/charts/plan-meter';
import { StackBar } from '@/components/charts/stack-bar';
import { AreaLine } from '@/components/charts/area-line';
import { ScopeTag } from '@/components/charts/scope-tag';
import { TableTwin } from '@/components/charts/table-twin';
import { tipText } from '@/components/charts/tip-text';
import { monthLabel, monthNames } from '@/components/charts/month-names';
import { compactUsd, m3, num, pct, signedUsd, usd } from '@/components/charts/format';
import { shortDay } from './day-format';

/** The P&L page over exactly the window a figure was computed on (#513). */
const pnlHref = (period: DashPeriod) => `/accounting/pnl?from=${period.from}&to=${period.to}`;

/**
 * «Bu oy foydasi» — the one number the owner opens the page for (the canvas's
 * hero), with the twelve months behind it as a line.
 *
 * The value is the P&L's net over the chosen period and the comparison is the
 * P&L page's own (`priorPeriodOf`), printed as DATES rather than a sentence
 * that has to guess what «the previous period» meant on a calendar edge
 * (judge O1: a January «Bu oy» is compared with last January, a whole month
 * with the whole month before). Absolute only: a percentage of a small or
 * negative profit misleads. The plan meter is drawn only for a calendar month
 * — the plan is monthly — and a closed month's pace is its last day.
 *
 * Defined OUTSIDE the `HeroTiles … TileNet` slice the balance pin reads: this
 * card never waits for the Balans line.
 */
export async function ProfitHero({
  period,
  company,
  canPlan,
  today,
}: {
  sight: CompanyMoneySight;
  period: DashPeriod;
  /** A warehouse is chosen: money has no per-warehouse figure, and says so. */
  company: boolean;
  canPlan: boolean;
  today: string;
}) {
  const t = await getTranslations('dashboard');
  const names = await monthNames();
  const [range, prior, pnl, target] = await Promise.all([
    loadPnlRange(period.from, period.to),
    loadPnlRange(period.prior.from, period.prior.to),
    loadPnl12(),
    period.month ? loadTargetFor(period.month) : null,
  ]);
  const now = pnlParts(range, 'total');
  const was = pnlParts(prior, 'total');
  const HERO: Record<DashPeriodKey, string> = {
    bugun: t('hero.bugun'),
    '7': t('hero.d7'),
    '30': t('hero.d30'),
    oy: t('hero.oy'),
    otgan: t('hero.otgan'),
  };
  // The comparison window, as dates (judge O1).
  const vs =
    period.prior.from === period.prior.to
      ? t('vsDay', { day: shortDay(period.prior.from, today) })
      : t('vsRange', { from: shortDay(period.prior.from, today), to: shortDay(period.prior.to, today) });
  const plan = period.month ? planProgress(now.net, target?.netProfitUsd, period.dom, period.daysInMonth) : null;
  // «How much a day is still needed» only while the month is running.
  const need = period.key === 'oy' ? planPace(now.net, target?.netProfitUsd, period.dom, period.daysInMonth) : null;

  // The line: leading months with nothing booked are the time before the
  // books began, not twelve months of zero profit.
  let first = pnl.months.findIndex((month) => {
    const parts = pnlParts(pnl, month);
    return Math.abs(parts.revenue) > 0.004 || Math.abs(parts.cost) > 0.004 || Math.abs(parts.net) > 0.004;
  });
  if (first < 0 || first > pnl.months.length - 2) first = Math.max(0, pnl.months.length - 2);
  const months = pnl.months.slice(first);
  const parts = months.map((month) => pnlParts(pnl, month));
  const values = parts.map((p) => p.net);
  const { ticks, bottom, top } = signedTicks(Math.min(0, ...values), Math.max(0, ...values));
  const last = months.length - 1;
  const labelled = new Set(months.map((_, i) => i).filter((i) => (last - i) % 3 === 0));
  const heading = (i: number) => monthLabel(names, months[i] ?? '', true);
  const margin = (i: number) => marginPct(parts[i]?.net ?? 0, parts[i]?.revenue ?? 0);
  const tips = months.map((_, i) =>
    tipText(heading(i), [
      [usd(parts[i]?.revenue ?? 0), t('sRevenue')],
      [usd(parts[i]?.cost ?? 0), t('sCost')],
      [`${signedUsd(parts[i]?.net ?? 0)}${margin(i) === null ? '' : ` · ${pct(margin(i)!)}`}`, t('sNet')],
    ]),
  );
  const PERIOD: Record<DashPeriodKey, string> = {
    bugun: t('period.bugun'),
    '7': t('period.d7'),
    '30': t('period.d30'),
    oy: t('period.oy'),
    otgan: t('period.otgan'),
  };

  return (
    <section
      className="card grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]"
      data-testid="dash-hero"
      aria-labelledby="dash-hero-label"
    >
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <p id="dash-hero-label" className="text-sm font-semibold text-ink-700" data-testid="dash-hero-label">
            {HERO[period.key]}
          </p>
          <span data-testid="dash-hero-scope" data-scope={company ? 'company' : 'period'}>
            <ScopeTag label={company ? t('scope.company') : PERIOD[period.key]} />
          </span>
        </div>
        <Link href={pnlHref(period)} className="block w-fit rounded-lg hover:bg-surface-sunken" data-testid="dash-hero-value">
          <span
            data-value={usd(now.net)}
            className={`whitespace-nowrap font-mono text-4xl font-extrabold tabular-nums md:text-5xl ${
              now.net < 0 ? 'text-bad' : 'text-ink-900'
            }`}
          >
            {usd(now.net)}
          </span>
        </Link>
        <p className="text-sm leading-snug">
          <AbsDelta value={now.net - was.net} up="good" />{' '}
          <span className="text-ink-500" data-testid="dash-hero-prior">
            {vs}
          </span>
        </p>
        {period.key === 'bugun' && <p className="text-2xs text-ink-500">{t('heroNoteDay')}</p>}
        {plan && target?.netProfitUsd ? (
          <div className="space-y-1 pt-1" data-testid="dash-hero-plan">
            <PlanMeter progress={plan} thick />
            <p className={`text-xs ${plan.behind && !plan.done ? 'text-warn' : 'text-ink-500'}`}>
              {t('plan', { pct: pct(plan.pct), amount: compactUsd(target.netProfitUsd) })}
              {plan.done ? <> · {t('planDone')}</> : need ? <> · {t('planNeed', { days: need.daysLeft, usd: usd(need.perDay) })}</> : null}
            </p>
          </div>
        ) : period.month && canPlan ? (
          <Link href="/accounting/reja" className="text-xs font-semibold text-brand-700">
            {t('setPlan')} →
          </Link>
        ) : null}
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-semibold text-ink-500">{t('heroLine')}</p>
          <ScopeTag label={t('scope.m12')} />
        </div>
        <AreaLine
          points={months.map((month, i) => ({ key: month, label: monthLabel(names, month), value: values[i] ?? 0 }))}
          bottom={bottom}
          top={top}
          ticks={ticks}
          partialLast
          tips={tips}
          labelled={labelled}
          endLabel={compactUsd(values[last] ?? 0)}
          ariaLabel={t('heroLineAria', { last: usd(values[last] ?? 0) })}
          testid="dash-hero-line"
        />
        <TableTwin
          summary={t('table')}
          testid="dash-hero-table"
          head={['', t('sRevenue'), t('sCost'), t('sNet'), t('sMargin')]}
          rows={months.map((month, i) => [
            heading(i),
            usd(parts[i]?.revenue ?? 0),
            usd(parts[i]?.cost ?? 0),
            <span key="n" className={(parts[i]?.net ?? 0) < 0 ? 'text-bad' : ''}>
              {signedUsd(parts[i]?.net ?? 0)}
            </span>,
            margin(i) === null ? '—' : pct(margin(i)!),
          ])}
        />
      </div>
    </section>
  );
}


/**
 * The four morning figures (canvas row 2). With money: the period's revenue
 * and cost — the parts of the hero's net, so revenue − cost is the figure
 * above them (0103's folded kurs farqi, `pnlParts`) — then the cash and the
 * receivable as they stand NOW. Without money: the warehouses' own figures.
 * Every tile links to the report that produced it, over the same window.
 */
export async function HeroTiles({
  sight,
  cargo,
  scopeKey,
  period,
  ombor,
  company,
  canPlan,
  today,
}: {
  /** Null for a viewer who may not read the company's money (`companyMoneySight`). */
  sight: CompanyMoneySight | null;
  cargo: boolean;
  scopeKey: string;
  period: DashPeriod;
  ombor: string | null;
  company: boolean;
  canPlan: boolean;
  today: string;
}) {
  const t = await getTranslations('dashboard');
  const money = sight !== null;

  const [balance, range, prior, pnl, target, aging, flow, intake, intakePrior, pipeline, trucks] = await Promise.all([
    // The cash half: the tile's value and its ⚠ need no net, so the row does
    // not wait for the Balans line's company-wide read (U03); the net
    // sub-line streams in on its own (`TileNet`).
    money ? loadBalanceParts() : null,
    money ? loadPnlRange(period.from, period.to) : null,
    money ? loadPnlRange(period.prior.from, period.prior.to) : null,
    money ? loadPnl12() : null,
    money && period.month ? loadTargetFor(period.month) : null,
    money ? loadAging() : null,
    money ? loadCashRange(period.from, period.to) : null,
    money ? null : loadIntakeRange(scopeKey, period.from, period.to),
    money ? null : loadIntakeRange(scopeKey, period.prior.from, period.prior.to),
    money ? null : loadPipeline(scopeKey),
    money || !cargo ? null : loadTrucks(scopeKey),
  ]);

  const PERIOD: Record<DashPeriodKey, string> = {
    bugun: t('period.bugun'),
    '7': t('period.d7'),
    '30': t('period.d30'),
    oy: t('period.oy'),
    otgan: t('period.otgan'),
  };
  const periodTag = <ScopeTag label={company ? t('scope.company') : PERIOD[period.key]} />;
  const nowTag = <ScopeTag label={company ? t('scope.company') : t('scope.now')} />;
  const vs =
    period.prior.from === period.prior.to
      ? t('vsDay', { day: shortDay(period.prior.from, today) })
      : t('vsRange', { from: shortDay(period.prior.from, today), to: shortDay(period.prior.to, today) });
  const tiles: React.ReactNode[] = [];

  if (money && balance && range && prior && pnl && aging && flow) {
    const now = pnlParts(range, 'total');
    const was = pnlParts(prior, 'total');
    const revenuePlan = period.month
      ? planProgress(now.revenue, target?.revenueUsd, period.dom, period.daysInMonth)
      : null;
    tiles.push(
      <StatTile
        key="revenue"
        testid="tile-revenue"
        href={pnlHref(period)}
        label={t('tileRevenue')}
        tag={periodTag}
        size="lg"
        value={compactUsd(now.revenue)}
        exact={usd(now.revenue)}
        lines={[<Delta key="d" delta={pctDelta(now.revenue, was.revenue)} abs={now.revenue - was.revenue} none={t('noPrior')} up="good" />, vs]}
        visual={
          <>
            <Sparkline values={pnl.months.map((month) => pnlParts(pnl, month).revenue)} />
            {revenuePlan && target?.revenueUsd ? (
              <div className="mt-1.5 space-y-0.5">
                <PlanMeter progress={revenuePlan} />
                <p className={`truncate text-2xs ${revenuePlan.behind && !revenuePlan.done ? 'text-warn' : 'text-ink-500'}`}>
                  {t('plan', { pct: pct(revenuePlan.pct), amount: compactUsd(target.revenueUsd) })}
                </p>
              </div>
            ) : null}
          </>
        }
        footer={
          period.month && !target?.revenueUsd && canPlan ? (
            <Link href="/accounting/reja" className="font-semibold text-brand-700">
              {t('setPlan')} →
            </Link>
          ) : undefined
        }
      />,
    );

    // The cost the P&L subtracts: direct + overhead, the kurs farqi folded in
    // (a gain lowers it). Each part is a figure the P&L page prints, so the
    // sum on the tile is checkable there (judge O3). Up is BAD here.
    const fx = Math.abs(now.fx) > 0.004 ? now.fx : 0;
    tiles.push(
      <StatTile
        key="cost"
        testid="tile-cost"
        href={pnlHref(period)}
        label={t('tileCost')}
        tag={periodTag}
        size="lg"
        value={compactUsd(now.cost)}
        exact={usd(now.cost)}
        lines={[
          <Delta key="d" delta={pctDelta(now.cost, was.cost)} abs={now.cost - was.cost} none={t('noPrior')} up="bad" />,
          <span key="p">
            {t('tileCostParts', { direct: compactUsd(now.direct), opex: compactUsd(now.opex) })}
            {fx !== 0 && <> · {t('tileCostFx', { fx: signedUsd(-fx) })}</>}
          </span>,
        ]}
        visual={<Sparkline values={pnl.months.map((month) => pnlParts(pnl, month).cost)} />}
      />,
    );

    // The Balans's own list of money its net leaves out for want of a rate
    // (U14) — an empty unrated till hides nothing and raises nothing.
    const unrated = balance.unratedTills.length > 0;
    tiles.push(
      <StatTile
        key="cash"
        testid="tile-cash"
        href="/accounting/balance"
        label={t('tileCash')}
        tag={nowTag}
        size="lg"
        value={
          <>
            {compactUsd(balance.cashUsd)}
            {unrated && <span className="text-warn" title={t('tileUnrated')}> ⚠</span>}
          </>
        }
        exact={usd(balance.cashUsd)}
        lines={[
          <Suspense key="net" fallback={<span className="text-ink-500">…</span>}>
            <TileNet />
          </Suspense>,
          t('tileTills', { n: balance.cashRows.length }),
          <span key="flow">
            {t('tilePeriodFlow', { in: compactUsd(flow.inflow), out: compactUsd(flow.outflow) })}
            {/* A cost with no rate reads $0 in the outflow (U24). */}
            {flow.unconverted.count > 0 && <span className="text-warn"> ⚠</span>}
          </span>,
        ]}
      />,
    );

    const buckets = aging.reduce(
      (acc, row) => row.buckets.map((value, i) => (acc[i] ?? 0) + value),
      [0, 0, 0, 0] as number[],
    );
    const old = (buckets[2] ?? 0) + (buckets[3] ?? 0);
    tiles.push(
      <StatTile
        key="receivable"
        testid="tile-receivable"
        href="/finance"
        label={t('tileReceivable')}
        tag={nowTag}
        size="lg"
        value={compactUsd(balance.receivableUsd)}
        exact={usd(balance.receivableUsd)}
        lines={[
          <span key="s">
            {t('tileReceivableSub', { n: aging.length })}{' '}
            <span className={old > 0.5 ? 'font-semibold text-warn' : ''}>{compactUsd(old)}</span>
          </span>,
          <span key="o" className={(buckets[3] ?? 0) > 0.5 ? 'font-semibold text-bad' : ''}>
            {t('tileOld90', { usd: compactUsd(buckets[3] ?? 0) })}
          </span>,
        ]}
        visual={
          <div className="pt-2">
            <StackBar
              height="h-1.5"
              parts={[
                { key: 'ord1', value: buckets[0] ?? 0 },
                { key: 'ord2', value: buckets[1] ?? 0 },
                { key: 'ord3', value: buckets[2] ?? 0 },
                { key: 'ord4', value: buckets[3] ?? 0 },
              ]}
            />
          </div>
        }
      />,
    );
  }

  if (!money && intake && intakePrior) {
    const journal = `/reports/receipts-journal?from=${period.from}&to=${period.to}${ombor ? `&ombor=${ombor}` : ''}`;
    tiles.push(
      <StatTile
        key="intake"
        testid="tile-intake"
        href={journal}
        label={t('tileIntake')}
        tag={<ScopeTag label={PERIOD[period.key]} />}
        size="lg"
        value={`${m3(intake.m3)} m³`}
        exact={String(intake.m3)}
        lines={[
          <Delta key="d" delta={pctDelta(intake.m3, intakePrior.m3)} abs={null} none={t('noPrior')} up="good" />,
          t('tileIntakeSub', { receipts: num(intake.receipts), boxes: num(intake.boxes) }),
          vs,
        ]}
      />,
    );
  }

  if (!money && pipeline) {
    const shelf = pipeline.cn.m3 + pipeline.uz.m3 + pipeline.other.m3;
    const boxes = pipeline.cn.boxes + pipeline.uz.boxes + pipeline.other.boxes;
    tiles.push(
      <StatTile
        key="stock"
        testid="tile-stock"
        href="/stock"
        label={t('tileStock')}
        tag={<ScopeTag label={t('scope.now')} />}
        size="lg"
        value={`${m3(shelf)} m³`}
        lines={[t('tileStockBoxes', { boxes: num(boxes) })]}
      />,
    );
  }

  if (!money && trucks) {
    tiles.push(
      <StatTile
        key="transit"
        testid="tile-transit"
        href="/transit"
        label={t('tileTransit')}
        tag={<ScopeTag label={t('scope.now')} />}
        size="lg"
        value={t('trucks', { n: trucks.total })}
        lines={[
          t('truckLoading', { n: trucks.loading }),
          ...(trucks.counts.stuck > 0
            ? [
                <span key="s" className="font-semibold text-warn">
                  {t('att.stuck', { n: trucks.counts.stuck })}
                </span>,
              ]
            : []),
        ]}
      />,
    );
  }

  return (
    <div data-testid="kpi-row" className={`grid grid-cols-2 gap-3 ${money ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
      {tiles}
    </div>
  );
}

/**
 * The net under the cash tile — the one figure on this row that waits for the
 * Balans line (U03), so it streams in under its own Suspense and the tiles
 * draw on the parts. A nested boundary, not a segment `loading.tsx` (#98 is
 * about the latter).
 */
async function TileNet() {
  const t = await getTranslations('dashboard');
  const balance = await loadBalance();
  return (
    <span className={balance.netUsd < 0 ? 'text-bad' : ''}>
      {t('tileNet', { amount: compactUsd(balance.netUsd) })}
    </span>
  );
}

/**
 * «▲ 12% · +$4.2K»: glyph + percentage + absolute, all printed (never only in a
 * title attribute, which a phone cannot reach). `up` says which direction is
 * good for THIS figure — more revenue is good news, more cost is not — so the
 * colour is the meaning and the glyph is the direction.
 */
function Delta({
  delta,
  abs,
  none,
  up,
}: {
  delta: number | null;
  abs: number | null;
  none: string;
  up: 'good' | 'bad';
}) {
  if (delta === null && abs === null) return <span className="text-ink-500">— {none}</span>;
  // No movement is not good news or bad news: a green «▲ $0» reads as growth.
  if ((delta === null || delta === 0) && Math.abs(abs ?? 0) < 0.5) return <span className="text-ink-500">= $0</span>;
  const rising = (delta ?? abs ?? 0) >= 0;
  const tone = rising === (up === 'good') ? 'text-good' : 'text-bad';
  return (
    <span className={tone}>
      {rising ? '▲' : '▼'} {delta === null ? signedUsd(abs ?? 0) : pct(Math.abs(delta))}
      {delta !== null && abs !== null && <> · {signedUsd(abs)}</>}
    </span>
  );
}

/** The hero's delta: absolute only (a percentage of a small or negative profit misleads). */
function AbsDelta({ value, up }: { value: number; up: 'good' | 'bad' }) {
  if (Math.abs(value) < 0.5) {
    return (
      <span className="font-semibold text-ink-500" data-testid="dash-hero-delta">
        = $0
      </span>
    );
  }
  const rising = value >= 0;
  const tone = rising === (up === 'good') ? 'text-good' : 'text-bad';
  return (
    <span className={`font-semibold ${tone}`} data-testid="dash-hero-delta">
      {rising ? '▲' : '▼'} {signedUsd(value)}
    </span>
  );
}
