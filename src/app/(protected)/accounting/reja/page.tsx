import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { isAnalyst } from '@/modules/platform/ai/tools';
import { PageHeader } from '@/components/ui/page';
import { profitAndLoss, monthsBetween } from '@/modules/wms/accounting/reports';
import { targetsFor } from '@/modules/wms/accounting/targets';
import { dashboardWindows, monthEnd, planProgress } from '@/modules/wms/reports/dashboard-math';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { monthLabel, monthNames } from '@/components/charts/month-names';
import { pct, usd } from '@/components/charts/format';
import { TargetForm } from './target-form';

export const dynamic = 'force-dynamic';

/**
 * «Oylik reja» (owner 5a): what each month should bring in and earn, beside
 * what it did. The facts are the P&L's own figures for the SAME months — one
 * `profitAndLoss` call over the window the dashboard uses, so a plan read here
 * and on the dashboard can never disagree (#513). Past and current months show
 * plan against fact; the next two take a plan only.
 *
 * His answer 4a: the owner and the admin, nobody else — the page is drawn
 * behind the admin ROLE (the dashboard's gate) and the save asks it again.
 */
export default async function PlanPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!isAnalyst(actor) || !actor.permissions.has('finance.reports')) redirect('/accounting');
  const canEdit = actor.permissions.has('admin.settings.manage');
  const t = await getTranslations('accounting');
  const names = await monthNames();

  const w = dashboardWindows(tashkentDay());
  // The next two months take a plan before they start.
  const next = dashboardWindows(w.nextMonthStart);
  const future = [next.month, dashboardWindows(next.nextMonthStart).month];
  const past = monthsBetween(w.m12Start, w.today);
  const [pnl, plans] = await Promise.all([
    profitAndLoss(w.m12Start, w.today),
    targetsFor([...past, ...future]),
  ]);

  const rows = [...future.reverse(), ...[...past].reverse()];

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-3xl">
      <PageHeader icon="chart" title={t('reja')} />
      <p className="text-sm text-ink-700">{t('rejaHint')}</p>
      <ul className="space-y-2">
        {rows.map((month) => {
          const plan = plans.get(month) ?? { revenueUsd: null, netProfitUsd: null };
          const isFuture = month > w.month;
          const revenue = pnl.revenue.byPeriod[month];
          const profit = pnl.netProfit.byPeriod[month];
          const current = month === w.month;
          const revenuePace = current
            ? planProgress(revenue ?? 0, plan.revenueUsd, w.dom, w.daysInMonth)
            : planProgress(revenue ?? 0, plan.revenueUsd, 1, 1);
          const profitPct =
            plan.netProfitUsd !== null && plan.netProfitUsd > 0 && profit !== undefined
              ? Math.round((profit / plan.netProfitUsd) * 1000) / 10
              : null;
          return (
            <li key={month} className="card space-y-2 !p-3" data-testid={`reja-${month}`}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-bold">{monthLabel(names, month, true)}</span>
                {current && <span className="chip-brand">{t('rejaCurrent')}</span>}
                {!isFuture && (
                  <Link
                    href={`/accounting/pnl?from=${month}-01&to=${monthEnd(month, w.today)}`}
                    className="ml-auto text-xs font-semibold text-brand-700"
                  >
                    {t('pnl')} →
                  </Link>
                )}
              </div>
              {!isFuture && (
                <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
                  <dt className="text-ink-500">{t('rejaFactRevenue')}</dt>
                  <dd className="text-right font-mono tabular-nums">
                    {usd(revenue ?? 0)}
                    {revenuePace && <span className="ml-1 text-ink-500">({pct(revenuePace.pct)})</span>}
                  </dd>
                  <dt className="text-ink-500">{t('rejaFactProfit')}</dt>
                  <dd className={`text-right font-mono tabular-nums ${(profit ?? 0) < 0 ? 'text-bad' : ''}`}>
                    {usd(profit ?? 0)}
                    {profitPct !== null && <span className="ml-1 text-ink-500">({pct(profitPct)})</span>}
                  </dd>
                </dl>
              )}
              {canEdit ? (
                <TargetForm month={month} revenueUsd={plan.revenueUsd} netProfitUsd={plan.netProfitUsd} />
              ) : (
                <p className="text-xs text-ink-500">
                  {t('rejaRevenue')}: {plan.revenueUsd === null ? '—' : usd(plan.revenueUsd)} · {t('rejaProfit')}:{' '}
                  {plan.netProfitUsd === null ? '—' : usd(plan.netProfitUsd)}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
