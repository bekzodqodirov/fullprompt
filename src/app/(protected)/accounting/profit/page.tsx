import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { profitByBatch, profitByClient, profitByRoute } from '@/modules/wms/accounting/reports';
import { resolvePeriod } from '@/modules/wms/accounting/period';
import { PeriodForm } from '../period-form';

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
  const params = await searchParams;
  const { from, to } = resolvePeriod(params);
  const view: View = params.view === 'client' || params.view === 'route' ? params.view : 'batch';

  const usd = (value: number) =>
    value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const profitClass = (value: number) => (value >= 0 ? 'text-green-700' : 'text-red-700');

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

  const totals = rows.reduce(
    (acc, row) => ({
      revenue: acc.revenue + row.revenueUsd,
      cost: acc.cost + row.costUsd,
      profit: acc.profit + row.profitUsd,
    }),
    { revenue: 0, cost: 0, profit: 0 },
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
              tab.key === view ? 'bg-blue-700 text-white' : 'bg-gray-100 hover:bg-gray-200'
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      <PeriodForm from={from} to={to} exportHref={`/api/accounting/profit?view=${view}`} />

      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-gray-300 bg-gray-50 text-left text-xs uppercase text-gray-500">
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
                  <td colSpan={8} className="p-3 text-center text-gray-500">
                    {t('empty')}
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr
                  key={'batchId' in row ? row.batchId : 'clientId' in row ? row.clientId : row.route}
                  className="border-b border-gray-100"
                >
                  <td className="p-2 font-mono font-bold">
                    {'code' in row ? (
                      <Link href={`/batches/${row.batchId}`} className="text-blue-800">
                        {row.code}
                      </Link>
                    ) : 'clientCode' in row ? (
                      <>
                        <span className="text-blue-800">{row.clientCode}</span>
                        <span className="ml-2 font-sans font-normal text-gray-600">
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
                  <td className="p-2 text-right font-mono">{usd(row.costUsd)}</td>
                  <td className={`p-2 text-right font-mono font-bold ${profitClass(row.profitUsd)}`}>
                    {usd(row.profitUsd)}
                  </td>
                  <td className="p-2 text-right">{row.marginPct}%</td>
                  {view !== 'client' && 'profitPerKg' in row && (
                    <td className="p-2 text-right font-mono">{row.profitPerKg}</td>
                  )}
                </tr>
              ))}
              {rows.length > 0 && (
                <tr className="border-t-2 border-gray-400 font-bold">
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
    </div>
  );
}
