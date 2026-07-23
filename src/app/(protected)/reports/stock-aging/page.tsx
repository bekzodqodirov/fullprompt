import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { SortTh, sortRows } from '@/components/sort-th';
import { stockAging } from '@/modules/wms/reports/queries';
import { BackLink } from '@/components/back-link';

const SORTABLE = ['whCode', 'code', 'boxCount', 'kg', 'm3', 'density', 'days'] as const;

/** Report §13.1: current stock with aging days + density (oldest first). */
export default async function StockAgingReportPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; dir?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const allWh = actor.permissions.has('reports.all_warehouses');
  if (!allWh && !actor.permissions.has('reports.own_warehouse')) redirect('/');
  const t = await getTranslations('reports');
  const { sort, dir } = await searchParams;

  const rows = sortRows(
    await stockAging(allWh ? undefined : actor.warehouseIds),
    sort,
    dir,
    SORTABLE,
  );

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-4xl">
      <BackLink href="/reports" label={t('title')} />
      <div className="flex flex-wrap items-baseline gap-2">
        <h1 className="text-xl font-bold">🕰 {t('stockAging')}</h1>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API download, not a page */}
        <a href="/api/reports/stock-aging" className="btn-secondary !min-h-9 ml-auto px-3 text-sm">
          ⬇️ XLSX
        </a>
      </div>
      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-gray-300 bg-gray-50 text-left text-xs uppercase text-gray-500">
                <SortTh label="WH" field="whCode" sort={sort} dir={dir} />
                <SortTh label={t('code')} field="code" sort={sort} dir={dir} />
                <th className="p-2">{t('product')}</th>
                <SortTh label="📦" field="boxCount" sort={sort} dir={dir} className="p-2 text-right" />
                <SortTh label="kg" field="kg" sort={sort} dir={dir} className="p-2 text-right" />
                <SortTh label="m³" field="m3" sort={sort} dir={dir} className="p-2 text-right" />
                <SortTh label="kg/m³" field="density" sort={sort} dir={dir} className="p-2 text-right" />
                <SortTh label={t('days')} field="days" sort={sort} dir={dir} className="p-2 text-right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-gray-100 last:border-0">
                  <td className="p-2 font-mono font-bold">{row.whCode}</td>
                  <td className="p-2 font-mono font-extrabold text-blue-800">{row.code}</td>
                  <td className="max-w-56 truncate p-2">{row.product}</td>
                  <td className="p-2 text-right">{row.boxCount}</td>
                  <td className="p-2 text-right">{row.kg}</td>
                  <td className="p-2 text-right">{row.m3}</td>
                  <td className="p-2 text-right text-gray-500">{row.density ?? '—'}</td>
                  {/* Owner's thresholds: ≥7 days yellow, ≥14 days red. */}
                  <td className={`p-2 text-right font-bold ${row.days >= 14 ? 'text-red-700' : row.days >= 7 ? 'text-yellow-600' : ''}`}>
                    {row.days}
                  </td>
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
