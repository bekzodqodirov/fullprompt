import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { chatBadges, tgViewerFor } from '@/modules/wms/crm/conversations';
import { closedLeadCounts, listLeads, listStages } from '@/modules/wms/crm/service';
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
/**
 * How many finished cards a board carries before it stops being a board.
 * Twenty is roughly one column's worth on a laptop — enough that last week's
 * wins are still in front of the salesperson, few enough that a year of them
 * cannot bury the open work.
 */
const CLOSED_ON_BOARD = 20;

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; arxiv?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.leads')) redirect('/');
  const t = await getTranslations('crm');
  const td = await getTranslations('deals');
  const params = await searchParams;

  const seesAll = actor.permissions.has('crm.leads.view_all');
  // Someone who may see everything still starts on their own leads; "all" is
  // one tap away and is what the owner uses.
  const mine = !seesAll || params.scope !== 'all';
  const scope = mine ? actor.id : undefined;

  // Round 47, the owner's item 6: «leadlar soni ko'payib ketgandan keyin lost
  // bo'lganlar va yutuq bo'lganlar juda chalg'itadi — ular nima qilinadi
  // keyinchalik». They are not deleted and they are not hidden: the finished
  // columns show the RECENT ones and say how many more there are, with a link
  // that opens the lot. A won lead from March is a record, not a task, and a
  // board is a list of work.
  const archive = params.arxiv === '1';
  const [stages, open, closed, closedTotals, badges] = await Promise.all([
    listStages(),
    listLeads({ ownerId: scope, openOnly: true }),
    listLeads({ ownerId: scope, closedOnly: true, limit: archive ? 400 : CLOSED_ON_BOARD }),
    closedLeadCounts(scope),
    // Whose card carries a chat — per viewer, same rule as /suhbatlar (#383).
    chatBadges(tgViewerFor(actor)),
  ]);
  const rows = [...open, ...closed];
  const shown = new Map<string, number>();
  for (const row of closed) {
    shown.set(row.lead.stageId, (shown.get(row.lead.stageId) ?? 0) + 1);
  }
  const hidden = Object.fromEntries(
    Object.entries(closedTotals)
      .map(([stageId, total]) => [stageId, total - (shown.get(stageId) ?? 0)] as const)
      .filter(([, left]) => left > 0),
  );
  // The board counts its own columns: a card dropped into another stage must
  // update the header immediately, before the server has revalidated.

  return (
    <div className="space-y-3">
      <PageHeader
        icon="target"
        title={t('funnel')}
        actions={
          <>
            {/* The two funnels are one sales story (owner: "bir-biriga
                chambarchas") — a lead is worked HERE and its jobs live THERE,
                so each board carries the door to the other. */}
            <Link href="/bitimlar" className="btn-secondary px-3" data-testid="to-deals">
              <Icon name="handshake" className="h-4 w-4" />
              {td('title')}
            </Link>
            <Link href="/crm/leads/new" className="btn-primary">
              <Icon name="plus" className="h-4 w-4" />
              {t('newLead')}
            </Link>
          </>
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
          chat: (lead.clientId && badges.get(lead.clientId)) || null,
        }))}
        hidden={hidden}
        archiveHref={`/crm?arxiv=1${mine ? '' : '&scope=all'}`}
      />

    </div>
  );
}
