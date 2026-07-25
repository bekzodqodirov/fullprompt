import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { listLeads, listStages, funnelReport } from '@/modules/wms/crm/service';
import { stageClass } from '../stage-color';

/**
 * The funnel board.
 *
 * Columns scroll sideways INSIDE the board rather than making the page scroll
 * — a 360 px phone cannot show eight stages at once, and this is the shape
 * every salesperson already knows from amoCRM.
 */
export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.leads')) redirect('/');
  const t = await getTranslations('crm');
  const params = await searchParams;

  const seesAll = actor.permissions.has('crm.leads.view_all');
  // Someone who may see everything still starts on their own leads; "all" is
  // one tap away and is what the owner uses.
  const mine = !seesAll || params.scope !== 'all';
  const scope = mine ? actor.id : undefined;

  const [stages, rows, funnel] = await Promise.all([
    listStages(),
    listLeads({ ownerId: scope }),
    funnelReport(scope),
  ]);
  const counts = Object.fromEntries(funnel.stages.map((row) => [row.stageId, row.n]));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">🎯 {t('funnel')}</h1>
        {seesAll && (
          <div className="flex gap-1 text-sm font-semibold">
            <Link
              href="/crm/leads"
              className={`rounded-lg px-3 py-1.5 ${mine ? 'bg-blue-700 text-white' : 'bg-gray-100'}`}
            >
              {t('mine')}
            </Link>
            <Link
              href="/crm/leads?scope=all"
              className={`rounded-lg px-3 py-1.5 ${mine ? 'bg-gray-100' : 'bg-blue-700 text-white'}`}
            >
              {t('all')}
            </Link>
          </div>
        )}
        <Link href="/crm/leads/new" className="btn-primary ml-auto">
          + {t('newLead')}
        </Link>
      </div>

      <div className="-mx-4 overflow-x-auto px-4 pb-2">
        <div className="flex gap-3">
          {stages.map((stage) => {
            const inStage = rows.filter((row) => row.lead.stageId === stage.id);
            return (
              <section key={stage.id} className="w-64 shrink-0">
                <header
                  className={`sticky top-0 rounded-lg border px-3 py-2 text-sm font-bold ${stageClass(
                    stage.color,
                  )}`}
                >
                  {stage.name}
                  <span className="ml-2 opacity-70">{counts[stage.id] ?? 0}</span>
                </header>
                <div className="mt-2 space-y-2">
                  {inStage.map(({ lead, sourceName, ownerName, clientCode }) => (
                    <Link
                      key={lead.id}
                      href={`/crm/leads/${lead.id}`}
                      className="card block !p-2.5 hover:bg-gray-50"
                    >
                      <div className="font-semibold [overflow-wrap:anywhere]">{lead.name}</div>
                      {lead.company && (
                        <div className="text-xs text-gray-600">{lead.company}</div>
                      )}
                      {lead.phone && <div className="text-xs font-mono">{lead.phone}</div>}
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-gray-500">
                        {sourceName && <span className="rounded bg-gray-100 px-1.5">{sourceName}</span>}
                        {ownerName && <span>{ownerName}</span>}
                        {clientCode && (
                          <span className="font-mono font-bold text-green-700">{clientCode}</span>
                        )}
                      </div>
                      {lead.nextActionAt && (
                        <div className="mt-1 text-[11px] font-semibold text-amber-700">
                          📅 {lead.nextActionAt}
                        </div>
                      )}
                    </Link>
                  ))}
                  {inStage.length === 0 && (
                    <p className="px-1 text-xs text-gray-400">{t('empty')}</p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-b border-gray-300 bg-gray-50 text-left text-xs uppercase text-gray-500">
                <th className="p-2">{t('source')}</th>
                <th className="p-2 text-right">{t('totalLeads')}</th>
                <th className="p-2 text-right">{t('kindWon')}</th>
                <th className="p-2 text-right">{t('kindLost')}</th>
                <th className="p-2 text-right">{t('winRate')}</th>
              </tr>
            </thead>
            <tbody>
              {funnel.sources.map((row) => (
                <tr key={row.name} className="border-b border-gray-100">
                  <td className="p-2">{row.name}</td>
                  <td className="p-2 text-right font-mono">{row.total}</td>
                  <td className="p-2 text-right font-mono text-green-700">{row.won}</td>
                  <td className="p-2 text-right font-mono text-red-700">{row.lost}</td>
                  <td className="p-2 text-right font-bold">{row.decided ? `${row.winRate}%` : '—'}</td>
                </tr>
              ))}
              {funnel.sources.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-3 text-center text-gray-500">
                    {t('empty')}
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
