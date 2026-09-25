import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import {
  pnlGaps,
  profitByBatch,
  profitByClient,
  profitByRoute,
  unbatchedMoney,
} from '@/modules/wms/accounting/reports';
import { resolvePeriod } from '@/modules/wms/accounting/period';
import { tripTotals } from '@/modules/wms/reports/dashboard-math';
import { PeriodForm } from '../period-form';
import { PnlGapsNote } from '../pnl-gaps';

type View = 'batch' | 'client' | 'route';

/**
 * Profitability: revenue against cost, per batch, client or corridor.
 *
 * This is the report that answers "did that trip earn money?" — both sides of
 * a batch belong to the batch whatever month they were entered, so unlike the
 * monthly P&L nothing here is distorted by a price agreed after the costs
 * were booked.
 */
export default async function ProfitPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; view?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.reports')) redirect('/accounting');
  const t = await getTranslations('accounting');
  const tf = await getTranslations('finance');
  const params = await searchParams;
  const { from, to } = resolvePeriod(params);
  const view: View = params.view === 'client' || params.view === 'route' ? params.view : 'batch';

  const usd = (value: number) =>
    value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const profitClass = (value: number) => (value >= 0 ? 'text-good' : 'text-bad');

  const tabs: { key: View; label: string }[] = [
    { key: 'batch', label: t('profitBatch') },
    { key: 'client', label: t('profitClient') },
    { key: 'route', label: t('profitRoute') },
  ];

  const rows =
    view === 'batch'
      ? await profitByBatch(from, to)
      : view === 'client'
        ? await profitByClient(from, to)
        : await profitByRoute(from, to);

  const [gaps, unbatched] = await Promise.all([
    pnlGaps(from, to),
    view === 'client' ? Promise.resolve(null) : unbatchedMoney(from, to),
  ]);

  // An internal leg is a cost row with no profit (R2a), and its cost is
  // already inside the cross-border truck's figure as «shu reysgacha» — so it
  // stays out of the totals, or that money would be counted twice.
  const isInternal = (row: (typeof rows)[number]) => 'internal' in row && row.internal;
  const totals = tripTotals(rows);
  const anyInternal = rows.some(isInternal);
  const unallocated = rows.filter((row) => 'unallocatedUsd' in row && row.unallocatedUsd > 0.009);
  const unallocatedUsd = unallocated.reduce(
    (sum, row) => sum + ('unallocatedUsd' in row ? row.unallocatedUsd : 0),
    0,
  );

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-5xl">
      <h1 className="text-xl font-bold">
        🚛 {tabs.find((tab) => tab.key === view)!.label}
      </h1>

      <div className="flex flex-wrap gap-1">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={`/accounting/profit?view=${tab.key}&from=${from}&to=${to}`}
            className={`rounded-lg px-3 py-2 text-sm font-semibold ${
              tab.key === view ? 'bg-brand-600 text-white' : 'bg-surface-sunken hover:bg-surface-sunken'
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      <PeriodForm from={from} to={to} exportHref={`/api/accounting/profit?view=${view}`} />
      <PnlGapsNote gaps={gaps} />

      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-line-strong bg-surface-sunken text-left text-xs uppercase text-ink-500">
                <th className="p-2">
                  {view === 'batch' ? t('batch') : view === 'client' ? t('client') : t('route')}
                </th>
                {view === 'batch' && <th className="p-2">{t('route')}</th>}
                {view !== 'client' && <th className="p-2 text-right">{t('boxes')}</th>}
                <th className="p-2 text-right">{t('revenue')} $</th>
                <th className="p-2 text-right">{t('cost')} $</th>
                <th className="p-2 text-right">{t('profit')} $</th>
                <th className="p-2 text-right">{t('margin')}</th>
                {view !== 'client' && <th className="p-2 text-right">{t('perKg')}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-3 text-center text-ink-500">
                    {t('empty')}
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr
                  key={'batchId' in row ? row.batchId : 'clientId' in row ? row.clientId : row.route}
                  className="border-b border-line"
                >
                  <td className="p-2 font-mono font-bold">
                    {'code' in row ? (
                      <Link href={`/batches/${row.batchId}`} className="text-brand-700">
                        {row.code}
                      </Link>
                    ) : 'clientCode' in row ? (
                      <>
                        <span className="text-brand-700">{row.clientCode}</span>
                        <span className="ml-2 font-sans font-normal text-ink-700">
                          {row.clientName}
                        </span>
                      </>
                    ) : (
                      row.route
                    )}
                  </td>
                  {view === 'batch' && 'route' in row && <td className="p-2 font-mono">{row.route}</td>}
                  {view !== 'client' && 'boxCount' in row && (
                    <td className="p-2 text-right">{row.boxCount}</td>
                  )}
                  <td className="p-2 text-right font-mono">{usd(row.revenueUsd)}</td>
                  <td className="p-2 text-right font-mono" data-testid="profit-cost">
                    {usd(row.costUsd)}
                    {'prevUsd' in row && row.prevUsd > 0.009 && (
                      <span className="block text-xs text-ink-500" title={tf('prevLegs')}>
                        ↩ {usd(row.prevUsd)}
                      </span>
                    )}
                    {'unallocatedUsd' in row && row.unallocatedUsd > 0.009 && (
                      <span className="block text-xs font-semibold text-warn">
                        ⚠ {usd(row.unallocatedUsd)}
                      </span>
                    )}
                  </td>
                  {row.profitUsd === null ? (
                    <td className="p-2 text-right text-ink-500" data-testid="profit-internal">
                      —
                    </td>
                  ) : (
                    <td className={`p-2 text-right font-mono font-bold ${profitClass(row.profitUsd)}`}>
                      {usd(row.profitUsd)}
                    </td>
                  )}
                  <td className="p-2 text-right">{row.marginPct === null ? '—' : `${row.marginPct}%`}</td>
                  {view !== 'client' && 'profitPerKg' in row && (
                    <td className="p-2 text-right font-mono">{row.profitPerKg ?? '—'}</td>
                  )}
                </tr>
              ))}
              {rows.length > 0 && (
                <tr className="border-t-2 border-line-strong font-bold">
                  <td className="p-2" colSpan={view === 'batch' ? 3 : view === 'route' ? 2 : 1}>
                    {t('total')}
                  </td>
                  <td className="p-2 text-right font-mono">{usd(totals.revenue)}</td>
                  <td className="p-2 text-right font-mono">{usd(totals.cost)}</td>
                  <td className={`p-2 text-right font-mono ${profitClass(totals.profit)}`}>
                    {usd(totals.profit)}
                  </td>
                  <td className="p-2 text-right">
                    {totals.revenue ? Math.round((totals.profit / totals.revenue) * 1000) / 10 : 0}%
                  </td>
                  {view !== 'client' && <td />}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {anyInternal && (
        <p className="text-xs text-ink-500" data-testid="profit-internal-note">
          {t('internalRowsNote')}
        </p>
      )}
      {unallocated.length > 0 && (
        <p className="card !p-3 text-sm font-semibold text-warn" data-testid="profit-unallocated">
          ⚠{' '}
          {t('unallocatedNote', { usd: `$${usd(unallocatedUsd)}`, count: unallocated.length })}
        </p>
      )}
      {unbatched && unbatched.revenueUsd > 0 && (
        <p className="card !p-3 text-sm text-ink-700" data-testid="profit-unbatched">
          ℹ️ {t('unbatchedNote', { revenue: `$${usd(unbatched.revenueUsd)}` })}
        </p>
      )}
    </div>
  );
}
