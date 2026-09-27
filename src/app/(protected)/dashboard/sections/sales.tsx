import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { loadLeadFlow, loadOpenDeals, loadSales } from '@/modules/wms/reports/dashboard';
import type { DashPeriod, DashPeriodKey } from '@/modules/wms/reports/dashboard-math';
import { compactUsd, num, pct } from '@/components/charts/format';
import { MeterRow } from '@/components/charts/meter-row';
import { ScopeTag } from '@/components/charts/scope-tag';
import { stageClass } from '../../crm/stage-color';

/**
 * «Savdo voronkasi»: where the open work sits NOW, stage by stage, in the
 * owner's own stage colours (`stageClass`, the board's identity vocabulary) —
 * and, for whoever decides the sales outcome, what the chosen period brought.
 *
 * No stage-to-stage percentage (judge, canvas row «84 · 70%»): the stage
 * counts are a snapshot of open work, and nothing records how many leads
 * passed through each stage, so a ratio of two snapshots would be a number
 * nobody can check. The period line is the tahlil screen's own two functions
 * (`leadArrivals`/`leadDecisions`), and it links there over the same days.
 *
 * The money half — the won dollars, the open deals' sum — stays inside the
 * outcome gate (judge O7): the logist holds `crm.leads` and reads the bars,
 * never the money.
 */
export async function FunnelCard({
  ownerId,
  seesOutcome,
  period,
  company,
}: {
  ownerId: string;
  seesOutcome: boolean;
  period: DashPeriod;
  /** A warehouse is chosen: sales have no warehouse, and the card says so. */
  company: boolean;
}) {
  const t = await getTranslations('dashboard');
  const tcrm = await getTranslations('crm');
  const [sales, flow, deals] = await Promise.all([
    loadSales(ownerId),
    seesOutcome ? loadLeadFlow(period.from, period.to) : null,
    seesOutcome ? loadOpenDeals() : null,
  ]);
  const max = Math.max(1, ...sales.byStage.map((row) => row.n));
  const decided = flow ? flow.won + flow.lost : 0;
  const rate = flow && decided > 0 ? (flow.won / decided) * 100 : null;
  const PERIOD: Record<DashPeriodKey, string> = {
    bugun: t('period.bugun'),
    '7': t('period.d7'),
    '30': t('period.d30'),
    oy: t('period.oy'),
    otgan: t('period.otgan'),
  };

  return (
    <div className="card min-w-0 space-y-2.5" data-testid="dash-funnel">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="font-semibold">{t('funnelTitle')}</p>
        <ScopeTag label={company ? t('scope.company') : t('scope.now')} />
        <Link href="/crm" className="ml-auto shrink-0 text-xs font-semibold text-brand-700">
          {tcrm('funnel')} →
        </Link>
      </div>
      <p className="text-2xs text-ink-500">{t('funnelNow')}</p>
      <ul className="space-y-1.5">
        {sales.byStage.map((stage) => (
          <li key={stage.name}>
            <MeterRow
              label={<span className="font-semibold">{stage.name}</span>}
              value={<span className="font-mono font-bold tabular-nums">{stage.n}</span>}
              pct={(stage.n / max) * 100}
              barClass={stageClass(stage.color)}
            />
          </li>
        ))}
      </ul>
      <Link href="/crm/today" className="block text-xs text-ink-700 hover:underline">
        <span className={sales.dueToday ? 'font-semibold text-warn' : ''}>
          {t('funnelOpen', { n: num(sales.open), calls: sales.dueToday })}
        </span>
      </Link>

      {seesOutcome && flow && deals && (
        <div className="space-y-1.5 border-t border-line pt-2" data-testid="dash-funnel-flow">
          <Link
            href={`/crm/tahlil?dan=${period.from}&gacha=${period.to}`}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs hover:underline"
          >
            <ScopeTag label={PERIOD[period.key]} />
            <span>{t('funnelFlow', { fresh: num(flow.fresh), won: num(flow.won), lost: num(flow.lost) })}</span>
            {rate !== null && <span className="font-semibold">· {t('funnelRate', { rate: pct(rate) })}</span>}
            <span className="font-mono tabular-nums">· {compactUsd(flow.wonUsd)}</span>
            {flow.wonOther > 0 && <span className="text-ink-500">· {t('otherCurrency', { n: flow.wonOther })}</span>}
          </Link>
          <Link href="/bitimlar" className="flex flex-wrap gap-x-1 text-xs hover:underline">
            <span className="font-semibold">{t('openDeals', { n: num(deals.count) })}</span>
            <span className="font-mono tabular-nums"> · {compactUsd(deals.usdSum)}</span>
            {deals.otherCurrency > 0 && (
              <span className="text-ink-500"> · {t('otherCurrency', { n: deals.otherCurrency })}</span>
            )}
          </Link>
        </div>
      )}
    </div>
  );
}
