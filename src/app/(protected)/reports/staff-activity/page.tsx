import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { staffActivity } from '@/modules/wms/reports/queries';
import { BackLink } from '@/components/back-link';

/** Report §13.8: staff activity per user per day (from audit + scans). */
export default async function StaffActivityPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('reports.all_warehouses')) redirect('/reports');
  const t = await getTranslations('reports');

  const rows = await staffActivity(14);

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <BackLink href="/reports" label={t('title')} />
      <div className="flex flex-wrap items-baseline gap-2">
        <h1 className="text-xl font-bold">👥 {t('staffActivity')}</h1>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API download */}
        <a href="/api/reports/staff-activity?days=14" className="btn-secondary !min-h-9 ml-auto px-3 text-sm">
          ⬇️ XLSX
        </a>
      </div>
      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-gray-300 bg-gray-50 text-left text-xs uppercase text-gray-500">
                <th className="p-2">{t('date')}</th>
                <th className="p-2">{t('employee')}</th>
                <th className="p-2 text-right">{t('receiptsCol')}</th>
                <th className="p-2 text-right">{t('edits')}</th>
                <th className="p-2 text-right">🖨</th>
                <th className="p-2 text-right">{t('scans')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-gray-100 last:border-0">
                  <td className="p-2 font-mono text-xs">{row.day}</td>
                  <td className="p-2">{row.name}</td>
                  <td className="p-2 text-right">{row.receipts || '—'}</td>
                  <td className="p-2 text-right">{row.edits || '—'}</td>
                  <td className="p-2 text-right">{row.prints || '—'}</td>
                  <td className="p-2 text-right">{row.scans || '—'}</td>
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
