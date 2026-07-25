import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { SortTh, sortRows } from '@/components/sort-th';
import { batchRegister } from '@/modules/wms/reports/queries';
import { BackLink } from '@/components/back-link';
import { PageHeader } from '@/components/ui/page';

const SORTABLE = ['code', 'status', 'departedAt', 'loaded', 'kg', 'costUsd'] as const;

/** Report §13.3: batch register with deviations + costs + unit cost. */
export default async function BatchRegisterReportPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; dir?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const allWh = actor.permissions.has('reports.all_warehouses');
  if (!allWh && !actor.permissions.has('reports.own_warehouse')) redirect('/');
  const t = await getTranslations('reports');
  const tb = await getTranslations('batches');
  const format = await getFormatter();
  const { sort, dir } = await searchParams;

  const rows = sortRows(
    await batchRegister(allWh ? undefined : actor.warehouseIds),
    sort,
    dir,
    SORTABLE,
  );
  const showCosts = actor.permissions.has('reports.all_warehouses');

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-5xl">
      <BackLink href="/reports" label={t('title')} />
      <div className="flex flex-wrap items-baseline gap-2">
        <PageHeader icon="truck" title={t('batchRegister')} />
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API download, not a page */}
        <a href="/api/reports/batches" className="btn-secondary !min-h-9 ml-auto px-3 text-sm">
          ⬇️ XLSX
        </a>
      </div>
      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-gray-300 bg-gray-50 text-left text-xs uppercase text-gray-500">
                <SortTh label={t('batch')} field="code" sort={sort} dir={dir} />
                <SortTh label={t('status')} field="status" sort={sort} dir={dir} />
                <SortTh label={t('departed')} field="departedAt" sort={sort} dir={dir} />
                <SortTh label="📦" field="loaded" sort={sort} dir={dir} className="p-2 text-right" />
                <th className="p-2 text-right" title={t('shortLoaded')}>⤵️</th>
                <th className="p-2 text-right" title={t('addedOnSpot')}>➕</th>
                <SortTh label="kg" field="kg" sort={sort} dir={dir} className="p-2 text-right" />
                <th className="p-2 text-right">m³</th>
                {showCosts && <SortTh label="$" field="costUsd" sort={sort} dir={dir} className="p-2 text-right" />}
                {showCosts && <th className="p-2 text-right">$/kg</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="p-2">
                    <Link href={`/batches/${row.id}`} className="font-mono font-extrabold text-blue-800">
                      {row.code}
                    </Link>{' '}
                    <span className="font-mono text-xs text-gray-500">{row.route}</span>
                  </td>
                  <td className="p-2">
                    <span className="rounded bg-gray-100 px-1.5 text-xs font-semibold">
                      {tb(`statuses.${row.status}`)}
                    </span>
                  </td>
                  <td className="p-2 text-xs text-gray-600">
                    {row.departedAt ? format.dateTime(row.departedAt, { dateStyle: 'short' }) : '—'}
                  </td>
                  <td className="p-2 text-right font-semibold">{row.loaded}</td>
                  <td className={`p-2 text-right ${row.short > 0 ? 'font-bold text-orange-700' : 'text-gray-400'}`}>
                    {row.short}
                  </td>
                  <td className={`p-2 text-right ${row.added > 0 ? 'font-bold text-red-700' : 'text-gray-400'}`}>
                    {row.added}
                  </td>
                  <td className="p-2 text-right">{row.kg}</td>
                  <td className="p-2 text-right">{row.m3}</td>
                  {showCosts && (
                    <td className="p-2 text-right font-mono font-semibold">
                      {row.costUsd > 0 ? `$${row.costUsd}` : '—'}
                    </td>
                  )}
                  {showCosts && (
                    <td className="p-2 text-right font-mono text-xs">
                      {row.usdPerKg !== null ? `$${row.usdPerKg}` : '—'}
                    </td>
                  )}
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
