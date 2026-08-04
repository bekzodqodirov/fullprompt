import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { arAging } from '@/modules/wms/accounting/reports';
import { toUzs, uzsRate } from '@/modules/wms/accounting/period';
import { PageHeader } from '@/components/ui/page';

/**
 * Who owes, and for how long.
 *
 * Payments settle the oldest charge first, so the age shown is the age of the
 * cargo that is genuinely still unpaid — a client who pays every month never
 * appears in the 90+ column just because they have been a client for a year.
 */
export default async function ReceivablesPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.reports')) redirect('/accounting');
  const t = await getTranslations('accounting');
  const params = await searchParams;
  const asOf =
    params.asOf && /^\d{4}-\d{2}-\d{2}$/.test(params.asOf)
      ? params.asOf
      : new Date().toISOString().slice(0, 10);
  const [rows, rate] = await Promise.all([arAging(asOf), uzsRate()]);

  const usd = (value: number) =>
    value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const totals = rows.reduce(
    (acc, row) => {
      acc.balance += row.balance;
      row.buckets.forEach((value, index) => {
        acc.buckets[index] = (acc.buckets[index] ?? 0) + value;
      });
      return acc;
    },
    { balance: 0, buckets: [0, 0, 0, 0] as number[] },
  );

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-4xl">
      <PageHeader icon="clock" title={t('receivables')} />

      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="block text-xs text-ink-500">{t('asOf')}</span>
          <input type="date" name="asOf" defaultValue={asOf} className="input !w-40" />
        </label>
        <button type="submit" className="btn-primary px-4">
          🔍
        </button>
        {/* A file download, not a page — deliberately a plain anchor. */}
        <a
          href={`/api/accounting/receivables?asOf=${asOf}`}
          className="btn-secondary whitespace-nowrap px-3"
        >
          ⬇️ XLSX
        </a>
      </form>

      <p className="text-sm font-semibold">
        {t('debt')}: {usd(totals.balance)} $
        {rate && (
          <span className="ml-2 font-normal text-ink-500">
            {toUzs(totals.balance, rate)?.toLocaleString('en-US')} UZS
          </span>
        )}
      </p>

      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-sm">
            <thead>
              <tr className="border-b border-line-strong bg-surface-sunken text-left text-xs uppercase text-ink-500">
                <th className="p-2">{t('client')}</th>
                <th className="p-2 text-right">{t('debt')} $</th>
                <th className="p-2 text-right">{t('days0')}</th>
                <th className="p-2 text-right">{t('days30')}</th>
                <th className="p-2 text-right">{t('days60')}</th>
                <th className="p-2 text-right text-bad">{t('days90')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-3 text-center text-ink-500">
                    {t('empty')}
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={row.clientCode} className="border-b border-line">
                  <td className="p-2">
                    <Link href={`/finance?q=${row.clientCode}`} className="font-mono font-bold text-brand-700">
                      {row.clientCode}
                    </Link>
                    <span className="ml-2 text-ink-700">{row.clientName}</span>
                  </td>
                  <td className="p-2 text-right font-mono font-bold">{usd(row.balance)}</td>
                  {row.buckets.map((value, index) => (
                    <td
                      key={index}
                      className={`p-2 text-right font-mono ${
                        index === 3 && value > 0 ? 'bg-bad/10 font-bold text-bad' : ''
                      }`}
                    >
                      {value ? usd(value) : ''}
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length > 0 && (
                <tr className="border-t-2 border-line-strong font-bold">
                  <td className="p-2">{t('total')}</td>
                  <td className="p-2 text-right font-mono">{usd(totals.balance)}</td>
                  {totals.buckets.map((value, index) => (
                    <td key={index} className="p-2 text-right font-mono">
                      {value ? usd(value) : ''}
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
