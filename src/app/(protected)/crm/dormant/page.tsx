import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { getSetting } from '@/modules/platform/settings/service';
import { dormantClients } from '@/modules/wms/crm/service';
import { PageHeader } from '@/components/ui/page';

/**
 * Clients who used to ship and stopped.
 *
 * The report a repeat-business kargo company loses the most money to: nobody
 * notices a regular going quiet, because nothing happens — no receipt, no
 * alert, no row anywhere until someone asks this question.
 */
export default async function DormantPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.leads')) redirect('/');
  const t = await getTranslations('crm');
  const params = await searchParams;

  const configured = Number(await getSetting('crm_dormant_days')) || 60;
  const days = Math.min(3650, Math.max(7, Number(params.days) || configured));
  const scope = actor.permissions.has('crm.leads.view_all') ? undefined : actor.id;
  const rows = await dormantClients(days, scope);

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-3xl">
      <PageHeader icon="sleep" title={t('dormant')} />

      <form method="get" className="flex items-end gap-2">
        <label className="text-sm">
          <span className="block text-xs text-gray-500">{t('daysQuiet')}</span>
          <input type="number" name="days" min={7} max={3650} defaultValue={days} className="input !w-28" />
        </label>
        <button type="submit" className="btn-primary px-4">
          🔍
        </button>
      </form>

      <p className="text-xs text-gray-500">ℹ️ {t('dormantNote')}</p>

      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-gray-300 bg-gray-50 text-left text-xs uppercase text-gray-500">
                <th className="p-2">{t('name')}</th>
                <th className="p-2 text-right">{t('daysQuiet')}</th>
                <th className="p-2">{t('lastCargo')}</th>
                <th className="p-2 text-right">{t('shipments')}</th>
                <th className="p-2 text-right">{t('debt')}</th>
                <th className="p-2">{t('owner')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-gray-100">
                  <td className="p-2">
                    <Link href={`/admin/clients/${row.id}`} className="font-mono font-bold text-blue-800">
                      {row.code}
                    </Link>
                    <span className="ml-2 text-gray-600">{row.name}</span>
                  </td>
                  <td
                    className={`p-2 text-right font-mono font-bold ${
                      row.daysQuiet > days * 2 ? 'text-red-700' : 'text-amber-700'
                    }`}
                  >
                    {row.daysQuiet}
                  </td>
                  <td className="p-2 font-mono text-gray-600">
                    {row.lastReceiptAt.slice(0, 10)}
                  </td>
                  <td className="p-2 text-right">{row.receiptCount}</td>
                  <td className="p-2 text-right font-mono">
                    {row.balanceUsd > 0 ? `${row.balanceUsd} $` : ''}
                  </td>
                  <td className="p-2 text-gray-600">{row.ownerName ?? ''}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-3 text-center text-gray-500">
                    ✅ {t('empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
