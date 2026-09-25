import { getTranslations } from 'next-intl/server';
import { cashFlow } from '@/modules/wms/accounting/reports';
import {
  loadAging,
  loadBalance,
  loadDecided,
  loadIntake,
  loadPipeline,
  loadPnl12,
  loadPnlPrior,
  loadTarget,
  loadTransit,
  loadWindows,
} from '@/modules/wms/reports/dashboard';
import { pctDelta, planProgress } from '@/modules/wms/reports/dashboard-math';
import { StatTile } from '@/components/charts/stat-tile';
import { Sparkline } from '@/components/charts/sparkline';
import { PlanMeter } from '@/components/charts/plan-meter';
import { StackBar } from '@/components/charts/stack-bar';
import { compactUsd, m3, num, pct, signedUsd } from '@/components/charts/format';
import Link from 'next/link';

/**
 * The six morning figures (spec «A»): cash he can count, this month's revenue
 * and net profit against his plan (5a), what clients owe and how old it is,
 * what the warehouses took in, and what sales won. Every flow is compared with
 * the SAME days of last month — month-to-date against a whole month would make
 * every month look worse until its last day.
 */
export async function HeroTiles({
  money,
  sales,
  cargo,
  scopeKey,
  canPlan,
}: {
  money: boolean;
  sales: boolean;
  cargo: boolean;
  scopeKey: string;
  canPlan: boolean;
}) {
  const t = await getTranslations('dashboard');
  const w = loadWindows();

  const [balance, pnl, prior, target, aging, flow, intake, decided, pipeline, transit] = await Promise.all([
    money ? loadBalance() : null,
    money ? loadPnl12() : null,
    money ? loadPnlPrior() : null,
    money ? loadTarget() : null,
    money ? loadAging() : null,
    money ? cashFlow(w.monthStart, w.today) : null,
    loadIntake(scopeKey),
    sales ? loadDecided() : null,
    money ? null : loadPipeline(scopeKey),
    money || !cargo ? null : loadTransit(scopeKey),
  ]);

  const byMonth = <T,>(rows: (T & { month: string })[]) => new Map(rows.map((row) => [row.month, row]));
  const intakeRows = byMonth(intake);
  const thisIntake = intakeRows.get(w.month);
  const prevIntake = intakeRows.get(w.prevMonth);
  const intakeTrend = (pnl?.months ?? monthsOf(w)).map((month) => intakeRows.get(month)?.m3 ?? 0);

  const tiles: React.ReactNode[] = [];

  if (money && balance && pnl && prior && aging && flow) {
    // The Balans's own list of money its net leaves out for want of a rate
    // (U14) — an empty unrated till hides nothing and raises nothing.
    const unrated = balance.unratedTills.length > 0;
    tiles.push(
      <StatTile
        key="cash"
        testid="tile-cash"
        href="/accounting/balance"
        label={t('tileCash')}
        value={
          <>
            {compactUsd(balance.cashUsd)}
            {unrated && <span className="text-warn" title={t('tileUnrated')}> ⚠</span>}
          </>
        }
        lines={[
          <span key="net" className={balance.netUsd < 0 ? 'text-bad' : ''}>
            {t('tileNet', { amount: compactUsd(balance.netUsd) })}
          </span>,
          <span key="flow">
            {t('tileMonthFlow', { in: compactUsd(flow.inflow), out: compactUsd(flow.outflow) })}
            {/* A cost with no rate reads $0 in the outflow (U24). */}
            {flow.unconverted.count > 0 && <span className="text-warn"> ⚠</span>}
          </span>,
        ]}
      />,
    );

    const revenue = pnl.revenue.byPeriod[w.month] ?? 0;
    const revenueDelta = pctDelta(revenue, prior.revenue.total);
    const revenuePlan = planProgress(revenue, target?.revenueUsd, w.dom, w.daysInMonth);
    tiles.push(
      <StatTile
        key="revenue"
        testid="tile-revenue"
        href={`/accounting/pnl?from=${w.monthStart}&to=${w.today}`}
        label={t('tileRevenue')}
        value={compactUsd(revenue)}
        lines={[
          <Delta key="d" delta={revenueDelta} abs={revenue - prior.revenue.total} none={t('noPrior')} />,
          t('vsPriorMtd', { day: w.dom }),
        ]}
        visual={
          <>
            <Sparkline values={pnl.months.map((month) => pnl.revenue.byPeriod[month] ?? 0)} />
            {revenuePlan && (
              <div className="mt-1.5 space-y-0.5">
                <PlanMeter progress={revenuePlan} />
                <p className={`truncate text-2xs ${revenuePlan.behind ? 'text-warn' : 'text-ink-500'}`}>
                  {t('plan', { pct: pct(revenuePlan.pct), amount: compactUsd(target!.revenueUsd!) })}
                </p>
              </div>
            )}
          </>
        }
        footer={
          !target?.revenueUsd && canPlan ? (
            <Link href="/accounting/reja" className="font-semibold text-brand-700">
              {t('setPlan')} →
            </Link>
          ) : undefined
        }
      />,
    );

    const profit = pnl.netProfit.byPeriod[w.month] ?? 0;
    const profitPlan = planProgress(profit, target?.netProfitUsd, w.dom, w.daysInMonth);
    tiles.push(
      <StatTile
        key="profit"
        testid="tile-profit"
        href={`/accounting/pnl?from=${w.monthStart}&to=${w.today}`}
        label={t('tileProfit')}
        value={compactUsd(profit)}
        valueTone={profit < 0 ? 'text-bad' : 'text-ink-900'}
        lines={[
          // Absolute only: a percentage of a small or negative base misleads.
          <Delta key="d" delta={null} abs={profit - prior.netProfit.total} none={t('noPrior')} absOnly />,
          t('vsPriorMtd', { day: w.dom }),
        ]}
        visual={
          <>
            <Sparkline values={pnl.months.map((month) => pnl.netProfit.byPeriod[month] ?? 0)} zeroLine />
            {profitPlan ? (
              <div className="mt-1.5 space-y-0.5">
                <PlanMeter progress={profitPlan} />
                <p className={`truncate text-2xs ${profitPlan.behind ? 'text-warn' : 'text-ink-500'}`}>
                  {t('plan', { pct: pct(profitPlan.pct), amount: compactUsd(target!.netProfitUsd!) })}
                </p>
              </div>
            ) : target?.netProfitUsd !== null && target?.netProfitUsd !== undefined ? (
              <p className="mt-1.5 truncate text-2xs text-ink-500">
                {t('planOnly', { amount: compactUsd(target.netProfitUsd) })}
              </p>
            ) : null}
          </>
        }
      />,
    );

    const buckets = aging.reduce(
      (acc, row) => row.buckets.map((value, i) => (acc[i] ?? 0) + value),
      [0, 0, 0, 0] as number[],
    );
    const old = (buckets[2] ?? 0) + (buckets[3] ?? 0);
    const debtors = aging.length;
    tiles.push(
      <StatTile
        key="receivable"
        testid="tile-receivable"
        href="/finance"
        label={t('tileReceivable')}
        value={compactUsd(balance.receivableUsd)}
        lines={[
          <span key="s">
            {t('tileReceivableSub', { n: debtors })}{' '}
            <span className={old > 0.5 ? 'font-semibold text-warn' : ''}>{compactUsd(old)}</span>
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

  const intakeDelta = pctDelta(thisIntake?.m3 ?? 0, prevIntake?.m3Mtd ?? 0);
  tiles.push(
    <StatTile
      key="intake"
      testid="tile-intake"
      href={`/reports/receipts-journal?from=${w.monthStart}&to=${w.today}`}
      label={t('tileIntake')}
      value={`${m3(thisIntake?.m3 ?? 0)} m³`}
      lines={[
        <Delta key="d" delta={intakeDelta} abs={null} none={t('noPrior')} />,
        t('tileIntakeSub', { receipts: num(thisIntake?.receipts ?? 0), boxes: num(thisIntake?.boxes ?? 0) }),
      ]}
      visual={<Sparkline values={intakeTrend} />}
    />,
  );

  if (sales && decided) {
    const rows = byMonth(decided);
    const now = rows.get(w.month);
    const prev = rows.get(w.prevMonth);
    const months = pnl?.months ?? monthsOf(w);
    tiles.push(
      <StatTile
        key="won"
        testid="tile-won"
        href={`/crm/tahlil?dan=${w.monthStart}&gacha=${w.today}`}
        label={t('tileWon')}
        value={compactUsd(now?.wonUsd ?? 0)}
        lines={[
          <Delta key="d" delta={pctDelta(now?.wonUsd ?? 0, prev?.wonUsdMtd ?? 0)} abs={null} none={t('noPrior')} />,
          t('tileWonSub', { won: now?.won ?? 0, lost: now?.lost ?? 0 }),
        ]}
        visual={<Sparkline values={months.map((month) => rows.get(month)?.wonUsd ?? 0)} />}
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
        value={`${m3(shelf)} m³`}
        lines={[
          transit
            ? t('tileStockSub', { boxes: num(boxes), trucks: transit.length })
            : t('tileStockBoxes', { boxes: num(boxes) }),
        ]}
      />,
    );
  }

  return (
    <div data-testid="kpi-row" className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
      {tiles}
    </div>
  );
}

function monthsOf(w: { m12Start: string; month: string }): string[] {
  const out: string[] = [];
  let [y, m] = [Number(w.m12Start.slice(0, 4)), Number(w.m12Start.slice(5, 7))];
  for (let i = 0; i < 12; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * «▲ 12% · +$4.2K»: glyph + percentage + absolute, all printed (never only in a
 * title attribute, which a phone cannot reach). Up is good for every figure on
 * this row, so the colour is the direction.
 */
function Delta({
  delta,
  abs,
  none,
  absOnly = false,
}: {
  delta: number | null;
  abs: number | null;
  none: string;
  absOnly?: boolean;
}) {
  if (absOnly && abs !== null) {
    const up = abs >= 0;
    return (
      <span className={up ? 'text-good' : 'text-bad'}>
        {up ? '▲' : '▼'} {signedUsd(abs)}
      </span>
    );
  }
  if (delta === null) return <span className="text-ink-500">— {none}</span>;
  const up = delta >= 0;
  return (
    <span className={up ? 'text-good' : 'text-bad'}>
      {up ? '▲' : '▼'} {pct(Math.abs(delta))}
      {abs !== null && <> · {signedUsd(abs)}</>}
    </span>
  );
}
