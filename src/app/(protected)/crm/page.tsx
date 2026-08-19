import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { salesManagerOptions } from '@/modules/platform/rbac/queries';
import { chatBadges, tgViewerFor } from '@/modules/wms/crm/conversations';
import {
  activeLostReasonLabels,
  closedLeadCounts,
  listLeads,
  listSources,
  listStages,
  openLeadCounts,
} from '@/modules/wms/crm/service';
import { KanbanBoard } from './leads/kanban';
import { Icon } from '@/components/ui/icon';
import {
  BoardChips,
  BoardFilter,
  InlineSearch,
  hrefWith,
  readBoardFilters,
} from '@/components/list/board-filter';
import { BoardMenu, boardMenuItem } from '@/components/list/board-menu';
import { PopoverRow } from '@/components/list/popover-row';
import { CardFieldsMenu } from '@/components/list/card-fields-menu';
import { LEAD_CARD_FIELDS, readCardFields } from '@/modules/platform/lists/card-fields';
import { ViewsMenu } from '@/components/list/views-menu';
import { canPublishViews, normalizeQuery } from '@/modules/platform/lists/query';
import { defaultViewFor, listViewsFor } from '@/modules/platform/lists/service';

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
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.leads')) redirect('/');
  const t = await getTranslations('crm');
  const td = await getTranslations('deals');
  const tc = await getTranslations('common');
  const tl = await getTranslations('lists');
  const raw = await searchParams;
  // A bare visit opens the person's default VIEW, exactly as the lists do —
  // a board is a list wearing columns.
  if (Object.keys(raw).length === 0) {
    const preset = await defaultViewFor('crm', actor.id);
    if (preset?.query) redirect(`/crm?${preset.query}`);
  }
  const params = {
    scope: Array.isArray(raw.scope) ? raw.scope[0] : raw.scope,
    arxiv: Array.isArray(raw.arxiv) ? raw.arxiv[0] : raw.arxiv,
    q: Array.isArray(raw.q) ? raw.q[0] : raw.q,
    hodim: Array.isArray(raw.hodim) ? raw.hodim[0] : raw.hodim,
  };
  const filters = readBoardFilters(raw);
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
  // Format-checked, not just permission-checked: this lands in
  // `eq(leads.ownerId, …)`, and a hand-typed non-uuid was a 22P02 500
  // for a view_all holder rather than a dropped filter (#514).
  const hodim =
    seesAll && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(params.hodim ?? '') ? params.hodim! : '';
  const scope = hodim || (mine ? actor.id : undefined);
  const q = (params.q ?? '').trim();
  // What every link on this screen has to carry, or the first tap on «all» or
  // on «+N · show all» drops the filter and reloads the unfiltered board.
  const carried = {
    ...(params.scope === 'all' ? { scope: 'all' } : {}),
    ...(q ? { q } : {}),
    ...(hodim ? { hodim } : {}),
    ...filters.raw,
  };
  // What listLeads and closedLeadCounts BOTH hear — one question (#513).
  const boardFilters = {
    ownerId: scope,
    q,
    sourceId: filters.sourceId,
    createdFrom: filters.createdFrom,
    createdTo: filters.createdTo,
    amountMin: filters.amountMin,
    amountMax: filters.amountMax,
    volMin: filters.volMin,
    volMax: filters.volMax,
    kgMin: filters.kgMin,
    kgMax: filters.kgMax,
    lenta: filters.lenta,
  };

  // Round 47, the owner's item 6: «leadlar soni ko'payib ketgandan keyin lost
  // bo'lganlar va yutuq bo'lganlar juda chalg'itadi — ular nima qilinadi
  // keyinchalik». They are not deleted and they are not hidden: the finished
  // columns show the RECENT ones and say how many more there are, with a link
  // that opens the lot. A won lead from March is a record, not a task, and a
  // board is a list of work.
  const archive = params.arxiv === '1';
  const [stages, sources, views, open, closed, openTotals, closedTotals, managers, lostReasonList] =
    await Promise.all([
    listStages(),
    listSources(),
    listViewsFor('crm', actor.id),
    listLeads({ ...boardFilters, openOnly: true }),
    listLeads({ ...boardFilters, closedOnly: true, limit: archive ? 400 : CLOSED_ON_BOARD }),
    // Every column's TRUE total — the open ones too, since round 74 caps
    // them per column. Cards are a slice; the header is the truth.
    openLeadCounts(boardFilters),
    // The SAME filters — the header prints the true total and the column
    // shows a slice, so counts filtered differently from rows make the
    // footer lie.
    closedLeadCounts(boardFilters),
    // Only offered to somebody who may see everybody's leads: handing YOUR
    // lead to a colleague is a supervisor's act, and a seller who cannot see
    // the board they would be moving it onto should not be doing it.
    seesAll ? salesManagerOptions() : Promise.resolve([]),
    // The owner's lost-reason list (round 98): non-empty, the board asks with
    // a sheet of these instead of the free-text prompt.
    activeLostReasonLabels(),
  ]);
  const rows = [...open, ...closed];
  // Whose card carries a chat — per viewer, same rule as /suhbatlar (#383).
  // AFTER the rows on purpose: bounded to the clients this board actually
  // drew, so a supervisor's badge query stops sorting the whole company's
  // message history per render (round 108).
  const badges = await chatBadges(
    tgViewerFor(actor),
    [...new Set(rows.map((row) => row.lead.clientId).filter((id): id is string => Boolean(id)))],
  );
  // What each column HOLDS versus what it was handed — one map for both
  // halves, so an open column that was capped says «+N» exactly as a closed
  // one always did.
  const shown = new Map<string, number>();
  for (const row of rows) {
    shown.set(row.lead.stageId, (shown.get(row.lead.stageId) ?? 0) + 1);
  }
  const hidden = Object.fromEntries(
    Object.entries({ ...openTotals, ...closedTotals })
      .map(([stageId, total]) => [stageId, total - (shown.get(stageId) ?? 0)] as const)
      .filter(([, left]) => left > 0),
  );
  // The board counts its own columns: a card dropped into another stage must
  // update the header immediately, before the server has revalidated.

  const advancedLabels = {
    filters: t('boardFilters'),
    source: t('source'),
    dateFrom: t('filterFrom'),
    dateTo: t('filterTo'),
    price: t('quotedAmount'),
    volume: t('quotedVolume'),
    weight: t('quotedWeight'),
    lentaSearch: t('filterLenta'),
    min: t('filterMin'),
    max: t('filterMax'),
  };
  // Every chip counts — the scope chip too, or the row renders unpaid and
  // eats 28px off the board's bottom (the geometry fence caught exactly this).
  const chipsOn =
    params.scope === 'all' || Boolean(q) || Boolean(hodim) || Object.keys(filters.raw).length > 0;

  return (
    // The board's height is a viewport calculation, so anything added ABOVE it
    // has to say how much room it took or the page grows a second scrollbar
    // under a board that was built not to have one (#354). Round 72 collapsed
    // the header / scope tabs / view chips / filter card into ONE toolbar row
    // — the owner's «urg'u kanban view'ga berilsin» — and round 73 took the
    // SubNav off this page too, so the price is the same as the deal board's:
    // the toolbar, plus the chips row when something is filtering.
    <div
      className="space-y-2"
      style={{
        ['--board-extra' as string]: `${3.25 + (chipsOn ? 2.5 : 0)}rem`,
      }}
    >
      {/* `relative` on the ROW: every popover on it (filter panel from md,
          views, ⋯) anchors to the row's edges, never to its own button —
          anchoring to a button put a panel off-screen at 360 px twice
          (#471, round 57). The row is a PopoverRow so opening one fold
          closes the others: three native details on one corner stack. */}
      {/* gap-1 below `sm`: at 360 px the six controls and their gaps left the
          title 74 px and «Воронка» — the DEFAULT locale's word — needs 77,
          so the board's own name rendered «Ворон…». Two pixels a gap buys
          it back without shrinking the type or dropping a control. */}
      <PopoverRow className="relative flex items-center gap-1 sm:gap-1.5">
        <h1 className="min-w-0 flex-1 truncate text-base sm:text-lg">{t('funnel')}</h1>
        {/* From md the search sits IN the toolbar — on a laptop the fold
            saves no height while search is the most-pressed control; the
            phone keeps it in the panel, as asked. */}
        <InlineSearch
          q={q}
          label={tc('search')}
          carried={{
            ...(params.scope === 'all' ? { scope: 'all' } : {}),
            ...(hodim ? { hodim } : {}),
            ...(archive ? { arxiv: '1' } : {}),
            ...filters.raw,
          }}
        />
        {/* The two funnels are one sales story (owner: "bir-biriga
            chambarchas") — each board carries the door to the other, in
            sight: daily navigation does not belong behind a ⋯. */}
        <Link
          href="/bitimlar"
          className="btn-secondary btn-icon"
          data-testid="to-deals"
          aria-label={td('title')}
        >
          <Icon name="handshake" className="h-4 w-4" />
        </Link>
        <BoardFilter
          q={q}
          scope={params.scope === 'all' ? 'all' : ''}
          hodim={hodim}
          people={managers.map((row) => ({ id: row.id, fullName: row.fullName }))}
          // The form REPLACES the URL, so anything it does not re-post is
          // cleared — a control that posts nothing reads as «remove» (#171).
          hidden={archive ? { arxiv: '1' } : {}}
          labels={{
            search: tc('search'),
            whose: t('whoseWork'),
            mine: t('mine'),
            all: t('all'),
            everyone: t('allManagers'),
            apply: tc('search'),
            clear: t('filterClear'),
          }}
          advanced={{
            values: filters.raw,
            sources: sources.map((source) => ({ id: source.id, name: source.name })),
            labels: advancedLabels,
          }}
        />
        {/* A filter worth typing twice is a filter worth a NAME — the same
            views engine as the lists, behind one button. */}
        <ViewsMenu
          screen="crm"
          path="/crm"
          views={views}
          currentQuery={normalizeQuery(raw)}
          canPublish={canPublishViews(actor.permissions)}
          label={tl('views')}
        />
        <BoardMenu label={tc('moreActions')}>
          {/* The section doors the tab strip used to shout from the top
              (round 73, owner: «yo'qot, halaqit qilmaydigan joyga o'tkaz»).
              The strip itself still renders on these pages. */}
          <Link href="/crm/today" className={boardMenuItem} data-testid="menu-today">
            <Icon name="phone" className="h-4 w-4 text-ink-500" />
            {t('today')}
          </Link>
          <Link href="/crm/dormant" className={boardMenuItem}>
            <Icon name="sleep" className="h-4 w-4 text-ink-500" />
            {t('dormant')}
          </Link>
          {actor.permissions.has('crm.manage') && (
            <>
              <Link href="/crm/tahlil" className={boardMenuItem}>
                <Icon name="report" className="h-4 w-4 text-ink-500" />
                {t('analytics')}
              </Link>
              <Link href="/crm/kelganlar" className={boardMenuItem}>
                <Icon name="target" className="h-4 w-4 text-ink-500" />
                {t('arrivals')}
              </Link>
              <Link href="/crm/people" className={boardMenuItem}>
                <Icon name="users" className="h-4 w-4 text-ink-500" />
                {t('people')}
              </Link>
              <Link href="/crm/settings" className={boardMenuItem}>
                <Icon name="settings" className="h-4 w-4 text-ink-500" />
                {t('settings')}
              </Link>
            </>
          )}
          <CardFieldsMenu
            inline
            board="lead"
            specs={LEAD_CARD_FIELDS}
            chosen={cardFields}
            labels={{
              title: t('cardFields'),
              save: tc('save'),
              field: (key) => t(key as 'company'),
            }}
          />
        </BoardMenu>
        <Link href="/crm/leads/new" className="btn-primary" aria-label={t('newLead')}>
          <Icon name="plus" className="h-4 w-4" />
          <span className="hidden sm:inline">{t('newLead')}</span>
        </Link>
      </PopoverRow>

      <BoardChips
        q={q}
        scope={params.scope === 'all' ? 'all' : ''}
        hodim={hodim}
        hodimName={managers.find((row) => row.id === hodim)?.fullName ?? null}
        values={filters.raw}
        sources={sources.map((source) => ({ id: source.id, name: source.name }))}
        labels={{ ...advancedLabels, search: tc('search'), all: t('all') }}
        current={{ ...carried, ...(archive ? { arxiv: '1' } : {}) }}
      />

      <KanbanBoard
        fields={cardFields}
        lostReasons={lostReasonList}
        // The follow-up date is coloured against the SERVER's today, so the
        // first HTML and the browser's first render agree (UTC days — the
        // convention `/bugun` already measures against, round 47).
        today={new Date().toISOString().slice(0, 10)}
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
          boardOrder: lead.boardOrder,
          name: lead.name,
          company: lead.company,
          phone: lead.phone,
          sourceName,
          ownerName,
          clientCode,
          quotedAmount: lead.quotedAmount,
          quotedCurrency: lead.quotedCurrency,
          quotedVolumeM3: lead.quotedVolumeM3,
          quotedWeightKg: lead.quotedWeightKg,
          nextActionAt: lead.nextActionAt,
          chat: (lead.clientId && badges.get(lead.clientId)) || null,
        }))}
        hidden={hidden}
        archiveHref={`/crm${hrefWith(carried, { arxiv: '1' })}`}
      />

    </div>
  );
}
