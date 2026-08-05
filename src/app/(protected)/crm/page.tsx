import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { salesManagerOptions } from '@/modules/platform/rbac/queries';
import { chatBadges, tgViewerFor } from '@/modules/wms/crm/conversations';
import { closedLeadCounts, listLeads, listStages } from '@/modules/wms/crm/service';
import { KanbanBoard } from './leads/kanban';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page';
import { BoardFilter, hrefWith } from '@/components/list/board-filter';
import { CardFieldsMenu } from '@/components/list/card-fields-menu';
import { LEAD_CARD_FIELDS, readCardFields } from '@/modules/platform/lists/card-fields';

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
  searchParams: Promise<{ scope?: string; arxiv?: string; q?: string; hodim?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.leads')) redirect('/');
  const t = await getTranslations('crm');
  const td = await getTranslations('deals');
  const tc = await getTranslations('common');
  const params = await searchParams;
  // Which lines this browser wants on a card — a cookie, so the first HTML is
  // already right and nothing rearranges itself after hydration.
  const cardFields = await readCardFields('lead');

  const seesAll = actor.permissions.has('crm.leads.view_all');
  // Someone who may see everything still starts on their own leads; "all" is
  // one tap away and is what the owner uses.
  const mine = !seesAll || params.scope !== 'all';
  // One colleague, when asked for. A `hodim` in the address bar from somebody
  // who may NOT see everybody's leads is ignored rather than obeyed: the
  // funnel's ownership rule is also the search's and the bot's, and a fourth
  // door has to ask the same question.
  const hodim = seesAll ? (params.hodim ?? '') : '';
  const scope = hodim || (mine ? actor.id : undefined);
  const q = (params.q ?? '').trim();
  // What every link on this screen has to carry, or the first tap on «all» or
  // on «+N · show all» drops the filter and reloads the unfiltered board.
  const carried = {
    ...(params.scope === 'all' ? { scope: 'all' } : {}),
    ...(q ? { q } : {}),
    ...(hodim ? { hodim } : {}),
  };

  // Round 47, the owner's item 6: «leadlar soni ko'payib ketgandan keyin lost
  // bo'lganlar va yutuq bo'lganlar juda chalg'itadi — ular nima qilinadi
  // keyinchalik». They are not deleted and they are not hidden: the finished
  // columns show the RECENT ones and say how many more there are, with a link
  // that opens the lot. A won lead from March is a record, not a task, and a
  // board is a list of work.
  const archive = params.arxiv === '1';
  const [stages, open, closed, closedTotals, badges, managers] = await Promise.all([
    listStages(),
    listLeads({ ownerId: scope, q, openOnly: true }),
    listLeads({ ownerId: scope, q, closedOnly: true, limit: archive ? 400 : CLOSED_ON_BOARD }),
    // The SAME q — the header prints the true total and the column shows a
    // slice, so counts filtered differently from rows make the footer lie.
    closedLeadCounts(scope, q),
    // Whose card carries a chat — per viewer, same rule as /suhbatlar (#383).
    chatBadges(tgViewerFor(actor)),
    // Only offered to somebody who may see everybody's leads: handing YOUR
    // lead to a colleague is a supervisor's act, and a seller who cannot see
    // the board they would be moving it onto should not be doing it.
    seesAll ? salesManagerOptions() : Promise.resolve([]),
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
    // The board's height is a viewport calculation, so anything added ABOVE it
    // has to say how much room it took or the page grows a second scrollbar
    // under a board that was built not to have one (#354). The filter row is
    // one line, or two when the colleague picker is offered.
    <div
      className="space-y-3"
      style={{ ['--board-extra' as string]: managers.length ? '8.9rem' : '4.9rem' }}
    >
      <PageHeader
        icon="target"
        title={t('funnel')}
        actions={
          <>
            {/* The two funnels are one sales story (owner: "bir-biriga
                chambarchas") — a lead is worked HERE and its jobs live THERE,
                so each board carries the door to the other. */}
            <Link
              href="/bitimlar"
              className="btn-secondary px-3"
              data-testid="to-deals"
              aria-label={td('title')}
            >
              <Icon name="handshake" className="h-4 w-4" />
              {/* Same rule as the deal board's door back — see the note there. */}
              <span className="hidden sm:inline">{td('title')}</span>
            </Link>
            <CardFieldsMenu
              board="lead"
              specs={LEAD_CARD_FIELDS}
              chosen={cardFields}
              labels={{
                title: t('cardFields'),
                save: tc('save'),
                field: (key) => t(key as 'company'),
              }}
            />
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
            { href: `/crm${hrefWith(carried, { scope: undefined })}`, label: t('mine'), on: mine },
            { href: `/crm${hrefWith(carried, { scope: 'all' })}`, label: t('all'), on: !mine },
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

      <BoardFilter
        q={q}
        hodim={hodim}
        people={managers.map((row) => ({ id: row.id, fullName: row.fullName }))}
        // The form REPLACES the URL, so anything it does not re-post is
        // cleared — a control that posts nothing reads as «remove» (#171).
        hidden={{
          ...(params.scope === 'all' ? { scope: 'all' } : {}),
          ...(archive ? { arxiv: '1' } : {}),
        }}
        labels={{
          search: tc('search'),
          everyone: t('allManagers'),
          apply: tc('search'),
          clear: t('filterClear'),
        }}
      />

      <KanbanBoard
        fields={cardFields}
        owners={
          managers.length
            ? managers.map((row) => ({ id: row.id, name: row.fullName }))
            : undefined
        }
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
        archiveHref={`/crm${hrefWith(carried, { arxiv: '1' })}`}
      />

    </div>
  );
}
