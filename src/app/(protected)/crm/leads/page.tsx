import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { listLeads, listStages, funnelReport } from '@/modules/wms/crm/service';
import { KanbanBoard } from './kanban';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page';

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
  // The board counts its own columns: a card dropped into another stage must
  // update the header immediately, before the server has revalidated.

  return (
    <div className="space-y-3">
      <PageHeader
        icon="target"
        title={t('funnel')}
        actions={
          <Link href="/crm/leads/new" className="btn-primary">
            <Icon name="plus" className="h-4 w-4" />
            {t('newLead')}
          </Link>
        }
      />

      {seesAll && (
        <div className="flex gap-1.5 text-sm font-semibold">
          {[
            { href: '/crm/leads', label: t('mine'), on: mine },
            { href: '/crm/leads?scope=all', label: t('all'), on: !mine },
          ].map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              className={`rounded-xl px-3 py-2 ${
                tab.on ? 'bg-brand-600 text-white shadow-card' : 'bg-surface-raised ring-1 ring-line'
              }`}
            >
              {tab.label}
            </Link>
          ))}
        </div>
      )}

      <KanbanBoard
        stages={stages.map((stage) => ({
          id: stage.id,
          name: stage.name,
          kind: stage.kind,
          color: stage.color,
        }))}
        leads={rows.map(({ lead, sourceName, ownerName, clientCode }) => ({
          id: lead.id,
          stageId: lead.stageId,
          name: lead.name,
          company: lead.company,
          phone: lead.phone,
          sourceName,
          ownerName,
          clientCode,
          nextActionAt: lead.nextActionAt,
        }))}
      />

      <div className="card !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-b border-line-strong bg-surface-sunken text-left text-xs uppercase text-ink-500">
                <th className="p-2">{t('source')}</th>
                <th className="p-2 text-right">{t('totalLeads')}</th>
                <th className="p-2 text-right">{t('kindWon')}</th>
                <th className="p-2 text-right">{t('kindLost')}</th>
                <th className="p-2 text-right">{t('winRate')}</th>
              </tr>
            </thead>
            <tbody>
              {funnel.sources.map((row) => (
                <tr key={row.name} className="border-b border-line">
                  <td className="p-2">{row.name}</td>
                  <td className="p-2 text-right font-mono">{row.total}</td>
                  <td className="p-2 text-right font-mono text-good">{row.won}</td>
                  <td className="p-2 text-right font-mono text-bad">{row.lost}</td>
                  <td className="p-2 text-right font-bold">{row.decided ? `${row.winRate}%` : '—'}</td>
                </tr>
              ))}
              {funnel.sources.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-3 text-center text-ink-500">
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
