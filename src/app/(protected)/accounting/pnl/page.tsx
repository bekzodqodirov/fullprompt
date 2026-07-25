import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { profitAndLoss, type PnlRow } from '@/modules/wms/accounting/reports';
import { resolvePeriod, toUzs, uzsRate } from '@/modules/wms/accounting/period';
import { PeriodForm } from '../period-form';
import { PageHeader } from '@/components/ui/page';

/**
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
  const [pnl, rate] = await Promise.all([profitAndLoss(from, to), uzsRate()]);

  const usd = (value: number) =>
    value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const uzs = (value: number) => {
    const converted = toUzs(value, rate);
    return converted === null ? '' : converted.toLocaleString('en-US');
  };

  const line = (row: PnlRow, label: string, className = '') => (
    <tr key={row.key} className={`border-b border-gray-100 ${className}`}>
      <td className="sticky left-0 z-10 bg-inherit p-2">{label}</td>
      {pnl.months.map((month) => (
        <td key={month} className="p-2 text-right font-mono">
          {usd(row.byPeriod[month] ?? 0)}
        </td>
      ))}
      <td className="p-2 text-right font-mono font-bold">{usd(row.total)}</td>
      <td className="p-2 text-right font-mono text-gray-500">{uzs(row.total)}</td>
    </tr>
  );

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-5xl">
      <PageHeader icon="chart" title={t('pnl')} />
      <PeriodForm from={from} to={to} exportHref="/api/accounting/pnl" />

      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-gray-300 bg-gray-50 text-left text-xs uppercase text-gray-500">
                <th className="sticky left-0 z-10 bg-gray-50 p-2">{t('category')}</th>
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
              {line(pnl.revenue, t('revenue'), 'bg-green-50 font-semibold')}
              {pnl.directCosts.map((row) => line(row, `— ${row.label}`, 'text-gray-700'))}
              {line(pnl.directTotal, t('directCosts'), 'font-semibold')}
              <tr className="border-b-2 border-gray-300 bg-blue-50 font-bold">
                <td className="sticky left-0 z-10 bg-blue-50 p-2">{t('grossProfit')}</td>
                {pnl.months.map((month) => (
                  <td key={month} className="p-2 text-right font-mono">
                    {usd(pnl.grossProfit.byPeriod[month] ?? 0)}
                    <span className="ml-1 text-xs font-normal text-gray-500">
                      {pnl.grossMarginPct[month] ?? 0}%
                    </span>
                  </td>
                ))}
                <td className="p-2 text-right font-mono">{usd(pnl.grossProfit.total)}</td>
                <td className="p-2 text-right font-mono text-gray-600">
                  {uzs(pnl.grossProfit.total)}
                </td>
              </tr>
              {pnl.opex.map((row) => line(row, `— ${row.label}`, 'text-gray-700'))}
              {line(pnl.opexTotal, t('opex'), 'font-semibold')}
              <tr
                className={`border-t-2 border-gray-400 font-bold ${
                  pnl.netProfit.total >= 0 ? 'bg-green-100' : 'bg-red-100'
                }`}
              >
                <td className="sticky left-0 z-10 bg-inherit p-2">{t('netProfit')}</td>
                {pnl.months.map((month) => (
                  <td key={month} className="p-2 text-right font-mono">
                    {usd(pnl.netProfit.byPeriod[month] ?? 0)}
                  </td>
                ))}
                <td className="p-2 text-right font-mono">{usd(pnl.netProfit.total)}</td>
                <td className="p-2 text-right font-mono text-gray-600">
                  {uzs(pnl.netProfit.total)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-gray-500">ℹ️ {t('pnlNote')}</p>
      {rate && <p className="text-xs text-gray-400">{t('uzsNote', { rate })}</p>}
    </div>
  );
}
