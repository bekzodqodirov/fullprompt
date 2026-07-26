import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { labelPrintLog } from '@/modules/wms/reports/queries';
import { BackLink } from '@/components/back-link';

/** Report §13.9: every label print/reprint with who and when. */
export default async function LabelPrintsPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('reports.all_warehouses')) redirect('/reports');
  const t = await getTranslations('reports');
  const format = await getFormatter();

  const rows = await labelPrintLog(30);

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <BackLink href="/reports" label={t('title')} />
      <div className="flex flex-wrap items-baseline gap-2">
        <h1 className="text-xl font-bold">🖨 {t('labelPrints')}</h1>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API download */}
        <a href="/api/reports/label-prints?days=30" className="btn-secondary !min-h-9 ml-auto px-3 text-sm">
          ⬇️ XLSX
        </a>
      </div>
      <div className="card !p-0">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-sm">
          <thead>
            <tr className="border-b border-line-strong bg-surface-sunken text-left text-xs uppercase text-ink-500">
              <th className="p-2">{t('when')}</th>
              <th className="p-2">{t('who')}</th>
              <th className="p-2">{t('receipt')}</th>
              <th className="p-2 text-right">{t('labels')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                <td className="p-2 text-xs">
                  {format.dateTime(row.at, { dateStyle: 'short', timeStyle: 'short' })}
                </td>
                <td className="max-w-32 truncate p-2">{row.name}</td>
                <td className="p-2">
                  <Link href={`/receipts/${row.receiptId}`} className="font-mono text-xs font-bold text-brand-700">
                    {row.receiptNumber ?? row.receiptId.slice(0, 8)}
                  </Link>
                </td>
                <td className="p-2 text-right font-semibold">{row.count ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {rows.length === 0 && <p className="p-4 text-sm text-ink-500">{t('noData')}</p>}
      </div>
    </div>
  );
}
