import { ilike } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { clients } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { clientHistory } from '@/modules/wms/reports/queries';

/** Report §13.6: one client's full cargo journey per lot. */
export default async function ClientHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('reports.all_warehouses')) redirect('/reports');
  const t = await getTranslations('reports');
  const format = await getFormatter();
  const { code } = await searchParams;

  const client = code?.trim()
    ? await db.query.clients.findFirst({ where: ilike(clients.clientCode, code.trim()) })
    : null;
  const rows = client ? await clientHistory(client.id) : [];

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-4xl">
      <div className="flex flex-wrap items-baseline gap-2">
        <h1 className="text-xl font-bold">📜 {t('clientHistory')}</h1>
        {client && (
          <a
            href={`/api/reports/client-history?clientId=${client.id}`}
            className="btn-secondary !min-h-9 ml-auto px-3 text-sm"
          >
            ⬇️ XLSX
          </a>
        )}
      </div>

      <form className="flex gap-2">
        <input
          name="code"
          className="input flex-1 font-mono uppercase"
          placeholder="GS777"
          defaultValue={code ?? ''}
        />
        <button type="submit" className="btn-primary px-4">
          🔍
        </button>
      </form>
      {code && !client && <p className="text-sm font-semibold text-red-700">{t('clientNotFound')}</p>}

      {client && (
        <div className="card !p-0">
          <p className="p-2 text-lg">
            <span className="font-mono font-extrabold text-blue-800">{client.clientCode}</span>{' '}
            {client.name}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-gray-300 bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <th className="p-2">{t('lot')}</th>
                  <th className="p-2">{t('product')}</th>
                  <th className="p-2">{t('date')}</th>
                  <th className="p-2">{t('batches')}</th>
                  <th className="p-2 text-right">📦</th>
                  <th className="p-2 text-right" title={t('inStock')}>🏭</th>
                  <th className="p-2 text-right" title={t('inTransitCol')}>🚛</th>
                  <th className="p-2 text-right" title={t('ready')}>🟢</th>
                  <th className="p-2 text-right" title={t('issued')}>🤝</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.lotId} className="border-b border-gray-100 last:border-0">
                    <td className="p-2 font-mono font-extrabold text-blue-800">{row.letter}</td>
                    <td className="max-w-52 truncate p-2">
                      {row.productNameZh}
                      {row.productNameRu && <span className="text-gray-500"> ({row.productNameRu})</span>}
                    </td>
                    <td className="p-2 text-xs">
                      {format.dateTime(row.receivedAt, { dateStyle: 'short' })}{' '}
                      <span className="font-mono">{row.whCode}</span>
                    </td>
                    <td className="max-w-32 truncate p-2 font-mono text-xs">{row.batchCodes ?? '—'}</td>
                    <td className="p-2 text-right font-semibold">{row.boxCount}</td>
                    <td className="p-2 text-right">{row.inStock || '—'}</td>
                    <td className="p-2 text-right">{row.inTransit || '—'}</td>
                    <td className="p-2 text-right">{row.ready || '—'}</td>
                    <td className="p-2 text-right">{row.issued || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && <p className="p-4 text-sm text-gray-500">{t('noData')}</p>}
        </div>
      )}
    </div>
  );
}
