import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { stockAging } from '@/modules/wms/reports/queries';

/** Report §13.1: current stock with aging days + density (oldest first). */
export default async function StockAgingReportPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const allWh = actor.permissions.has('reports.all_warehouses');
  if (!allWh && !actor.permissions.has('reports.own_warehouse')) redirect('/');
  const t = await getTranslations('reports');

  const rows = await stockAging(allWh ? undefined : actor.warehouseIds);

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-4xl">
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
                <th className="p-2">WH</th>
                <th className="p-2">{t('code')}</th>
                <th className="p-2">{t('product')}</th>
                <th className="p-2 text-right">📦</th>
                <th className="p-2 text-right">kg</th>
                <th className="p-2 text-right">m³</th>
                <th className="p-2 text-right">kg/m³</th>
                <th className="p-2 text-right">{t('days')}</th>
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
                  <td className={`p-2 text-right font-bold ${row.days > 30 ? 'text-red-700' : row.days > 14 ? 'text-orange-600' : ''}`}>
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
