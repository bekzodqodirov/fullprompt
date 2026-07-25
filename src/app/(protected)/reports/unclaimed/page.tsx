import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { SortTh, sortRows } from '@/components/sort-th';
import { unclaimedReport } from '@/modules/wms/reports/queries';
import { BackLink } from '@/components/back-link';
import { PageHeader } from '@/components/ui/page';

const SORTABLE = ['number', 'marking', 'whCode', 'days', 'boxesInStock', 'kg'] as const;

/** Report §13.5: unclaimed cargo still sitting in stock. */
export default async function UnclaimedReportPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; dir?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const allWh = actor.permissions.has('reports.all_warehouses');
  if (!allWh && !actor.permissions.has('reports.own_warehouse')) redirect('/');
  const t = await getTranslations('reports');
  const format = await getFormatter();
  const { sort, dir } = await searchParams;

  const rows = sortRows(
    await unclaimedReport(allWh ? undefined : actor.warehouseIds),
    sort,
    dir,
    SORTABLE,
  );

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <BackLink href="/reports" label={t('title')} />
      <div className="flex flex-wrap items-baseline gap-2">
        <PageHeader icon="alert" title={t('unclaimedReport')} />
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API download */}
        <a href="/api/reports/unclaimed" className="btn-secondary !min-h-9 ml-auto px-3 text-sm">
          ⬇️ XLSX
        </a>
      </div>
      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-gray-300 bg-gray-50 text-left text-xs uppercase text-gray-500">
                <SortTh label="№" field="number" sort={sort} dir={dir} />
                <SortTh label={t('marking')} field="marking" sort={sort} dir={dir} />
                <SortTh label="WH" field="whCode" sort={sort} dir={dir} />
                <SortTh label={t('days')} field="days" sort={sort} dir={dir} className="p-2 text-right" />
                <SortTh label="📦" field="boxesInStock" sort={sort} dir={dir} className="p-2 text-right" />
                <SortTh label="kg" field="kg" sort={sort} dir={dir} className="p-2 text-right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="p-2">
                    <Link href={`/receipts/${row.id}`} className="font-mono text-xs font-bold text-blue-800">
                      {row.number}
                    </Link>
                    <span className="ml-2 text-xs text-gray-500">
                      {format.dateTime(row.receivedAt, { dateStyle: 'short' })}
                    </span>
                  </td>
                  <td className="p-2 font-mono font-extrabold text-orange-700">{row.marking ?? '—'}</td>
                  <td className="p-2 font-mono font-bold">{row.whCode}</td>
                  <td className={`p-2 text-right font-bold ${row.days >= 14 ? 'text-red-700' : row.days >= 7 ? 'text-yellow-600' : ''}`}>
                    {row.days}
                  </td>
                  <td className="p-2 text-right font-semibold">{row.boxesInStock}</td>
                  <td className="p-2 text-right">{row.kg}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <p className="p-4 text-sm text-gray-500">✅ {t('noUnclaimed')}</p>}
      </div>
    </div>
  );
}
