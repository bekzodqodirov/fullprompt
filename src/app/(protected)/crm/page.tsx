import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { listLeads, listStages } from '@/modules/wms/crm/service';
import { KanbanBoard } from './leads/kanban';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page';

/**
 * The funnel board — and nothing else.
 *
 * The per-source conversion table used to sit under it; the owner asked for a
 * clean kanban, and a report is not what you open a board to read.
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

  const [stages, rows] = await Promise.all([listStages(), listLeads({ ownerId: scope })]);
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
            { href: '/crm', label: t('mine'), on: mine },
            { href: '/crm?scope=all', label: t('all'), on: !mine },
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

    </div>
  );
}
