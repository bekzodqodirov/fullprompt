import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { cashFlow } from '@/modules/wms/accounting/reports';
import { accountBalances } from '@/modules/wms/accounting/service';
import { resolvePeriod, toUzs, uzsRate } from '@/modules/wms/accounting/period';
import { PeriodForm } from '../period-form';

/** Money that actually moved, plus where it currently sits. */
export default async function CashFlowPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.reports')) redirect('/accounting');
  const t = await getTranslations('accounting');
  const { from, to } = resolvePeriod(await searchParams);
  const [flow, balances, rate] = await Promise.all([
    cashFlow(from, to),
    accountBalances(),
    uzsRate(),
  ]);

  const usd = (value: number) =>
    value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const label = (key: string) =>
    key === 'clientPayments' || key === 'cargoCosts' ? t(key) : key;

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-3xl">
      <h1 className="text-xl font-bold">💵 {t('cashflow')}</h1>
      <PeriodForm from={from} to={to} exportHref="/api/accounting/cashflow" />

      <div className="card !p-0">
        <table className="w-full text-sm">
          <tbody>
            {flow.rows.map((row, index) => (
              <tr key={`${row.label}-${index}`} className="border-b border-gray-100">
                <td className="p-2">
                  {row.kind === 'in' ? '⬅️' : '➡️'} {label(row.label)}
                </td>
                <td
                  className={`p-2 text-right font-mono ${
                    row.kind === 'in' ? 'text-green-700' : 'text-red-700'
                  }`}
                >
                  {row.kind === 'in' ? '+' : '−'}
                  {usd(row.amountUsd)}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-gray-400 font-bold">
              <td className="p-2">{t('net')}</td>
              <td
                className={`p-2 text-right font-mono ${
                  flow.net >= 0 ? 'text-green-700' : 'text-red-700'
                }`}
              >
                {usd(flow.net)}
                {rate && (
                  <span className="ml-2 text-xs font-normal text-gray-500">
                    {toUzs(flow.net, rate)?.toLocaleString('en-US')} UZS
                  </span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {flow.transferCount > 0 && (
        <p className="text-xs text-gray-500">
          ℹ️ {t('transfersExcluded', { n: flow.transferCount })}
        </p>
      )}

      <div className="card space-y-1">
        <h2 className="text-sm font-bold uppercase text-gray-500">🏦 {t('balance')}</h2>
        {balances
          .filter((row) => row.active)
          .map((row) => (
            <div key={row.id} className="flex items-baseline gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              <span className="font-mono font-bold">
                {row.balance.toLocaleString('en-US')} {row.currency}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}
