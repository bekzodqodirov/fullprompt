import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { SortTh, sortRows } from '@/components/sort-th';
import { receiptsJournal } from '@/modules/wms/reports/queries';
import { BackLink } from '@/components/back-link';

const SORTABLE = ['number', 'receivedAt', 'whCode', 'boxCount', 'kg'] as const;

/** Report §13.2: receipts journal (period, WH, operator). */
export default async function ReceiptsJournalPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; dir?: string; days?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const allWh = actor.permissions.has('reports.all_warehouses');
  if (!allWh && !actor.permissions.has('reports.own_warehouse')) redirect('/');
  const t = await getTranslations('reports');
  const format = await getFormatter();
  const { sort, dir, days: rawDays } = await searchParams;
  const days = Math.min(365, Math.max(1, Number(rawDays) || 30));

  const rows = sortRows(
    await receiptsJournal(days, allWh ? undefined : actor.warehouseIds),
    sort,
    dir,
    SORTABLE,
  );
  const params = { days: String(days) };

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-4xl">
      <BackLink href="/reports" label={t('title')} />
      <div className="flex flex-wrap items-baseline gap-2">
        <h1 className="text-xl font-bold">📥 {t('receiptsJournal')}</h1>
        <span className="flex gap-1 text-sm">
          {[7, 30, 90].map((d) => (
            <Link
              key={d}
              href={`?days=${d}`}
              className={`rounded px-2 py-0.5 font-semibold ${d === days ? 'bg-blue-700 text-white' : 'bg-gray-100'}`}
            >
              {d}
            </Link>
          ))}
        </span>
        <a href={`/api/reports/receipts-journal?days=${days}`} className="btn-secondary !min-h-9 ml-auto px-3 text-sm">
          ⬇️ XLSX
        </a>
      </div>
      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead>
              <tr className="border-b border-gray-300 bg-gray-50 text-left text-xs uppercase text-gray-500">
                <SortTh label="№" field="number" sort={sort} dir={dir} params={params} />
                <SortTh label={t('date')} field="receivedAt" sort={sort} dir={dir} params={params} />
                <SortTh label="WH" field="whCode" sort={sort} dir={dir} params={params} />
                <th className="p-2">{t('client')}</th>
                <th className="p-2">{t('operator')}</th>
                <SortTh label="📦" field="boxCount" sort={sort} dir={dir} params={params} className="p-2 text-right" />
                <SortTh label="kg" field="kg" sort={sort} dir={dir} params={params} className="p-2 text-right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="p-2">
                    <Link href={`/receipts/${row.id}`} className="font-mono text-xs font-bold text-blue-800">
                      {row.number}
                    </Link>
                  </td>
                  <td className="p-2 text-xs">{format.dateTime(row.receivedAt, { dateStyle: 'short' })}</td>
                  <td className="p-2 font-mono font-bold">{row.whCode}</td>
                  <td className="p-2 font-mono font-extrabold text-blue-800">
                    {row.clientCode ?? row.marking ?? '?'}
                  </td>
                  <td className="max-w-36 truncate p-2 text-xs text-gray-600">{row.operator}</td>
                  <td className="p-2 text-right font-semibold">{row.boxCount}</td>
                  <td className="p-2 text-right">{row.kg}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <p className="p-4 text-sm text-gray-500">{t('noData')}</p>}
      </div>
    </div>
  );
}
