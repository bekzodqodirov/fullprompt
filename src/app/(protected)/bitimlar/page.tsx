import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { chatBadges, tgViewerFor } from '@/modules/wms/crm/conversations';
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
import { ViewsMenu } from '@/components/list/views-menu';
import { canPublishViews, normalizeQuery } from '@/modules/platform/lists/query';
import { defaultViewFor, listViewsFor } from '@/modules/platform/lists/service';
import { CardFieldsMenu } from '@/components/list/card-fields-menu';
import { DEAL_CARD_FIELDS, readCardFields } from '@/modules/platform/lists/card-fields';
import { salesManagerOptions } from '@/modules/platform/rbac/queries';
import {
  canWriteDeal,
  closedDealCounts,
  dealsNeedingAttention,
  listDeals,
  listStages,
  openDealCounts,
} from '@/modules/wms/deals/service';
import { DealBoard, type BoardDeal } from './board';

/**
 * The deal board — "which of my jobs is stuck".
 *
 * A lead is somebody who is not yet a client and is worked once; a deal is an
 * existing client's job and repeats. With 1442 clients shipping again and
 * again, a funnel filled with the same names stops being a funnel, which is
 * why this board exists beside the lead board rather than instead of it
 * (docs/DEALS.md, "The board").
 */
/** See the note on the lead board's constant of the same name. */
const CLOSED_ON_BOARD = 20;

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!canWriteDeal(actor.permissions)) redirect('/');
  const t = await getTranslations('deals');
  const tc = await getTranslations('crm');
  const tcommon = await getTranslations('common');
  const tl = await getTranslations('lists');
  const raw = await searchParams;
  // A bare visit opens the person's default VIEW, exactly as the lists do.
  if (Object.keys(raw).length === 0) {
    const preset = await defaultViewFor('bitimlar', actor.id);
    if (preset?.query) redirect(`/bitimlar?${preset.query}`);
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
  const cardFields = await readCardFields('deal');

  const seesAll = actor.permissions.has('crm.leads.view_all');
  // Somebody who may see everything still starts on their own jobs; "all" is
  // one tap away and is what the owner uses.
  const mine = !seesAll || params.scope !== 'all';
  // A `hodim` from somebody who may not see everybody's jobs is ignored, not
  // obeyed — the same rule the funnel, the search and the bot all ask.
  const hodim = seesAll ? (params.hodim ?? '') : '';
  const scope = hodim || (mine ? actor.id : undefined);
  const q = (params.q ?? '').trim();
  const carried = {
    ...(params.scope === 'all' ? { scope: 'all' } : {}),
    ...(q ? { q } : {}),
    ...(hodim ? { hodim } : {}),
    ...filters.raw,
  };
  // What listDeals and closedDealCounts BOTH hear — one question (#513).
  const boardFilters = {
    ownerId: scope,
    q,
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

  // Same rule as the lead funnel (round 47, owner's item 6): the won and lost
  // columns keep the recent cards and say how many more they hold. A closed
  // job is a record; a board is a list of work.
  const archive = params.arxiv === '1';
  const [stages, views, open, closed, openTotals, closedTotals, attention, badges, managers] =
    await Promise.all([
    listStages(),
    listViewsFor('bitimlar', actor.id),
    listDeals({ ...boardFilters, openOnly: true }),
    listDeals({ ...boardFilters, closedOnly: true, limit: archive ? 400 : CLOSED_ON_BOARD }),
    // Every column's TRUE total — the open ones too, since round 74 caps
    // them per column. Cards are a slice; the header is the truth.
    openDealCounts(boardFilters),
    // The SAME filters as the rows, or the «+N · show all» footer lies.
    closedDealCounts(boardFilters),
    dealsNeedingAttention(scope, q),
    // Whose card carries a chat — per viewer, same rule as /suhbatlar (#383).
    chatBadges(tgViewerFor(actor)),
    // The picker's options. Offered only to somebody who may see everybody's
    // work — and never derived from the loaded rows, which once filtered to
    // one person would collapse to that person with no way back.
    seesAll ? salesManagerOptions() : Promise.resolve([]),
  ]);
  const rows = [...open, ...closed];
  const shownClosed = new Map<string, number>();
  for (const row of rows) {
    shownClosed.set(row.stageId, (shownClosed.get(row.stageId) ?? 0) + 1);
  }
  const hidden = Object.fromEntries(
    Object.entries({ ...openTotals, ...closedTotals })
      .map(([stageId, total]) => [stageId, total - (shownClosed.get(stageId) ?? 0)] as const)
      .filter(([, left]) => left > 0),
  );

  const flags = new Map(attention.map((row) => [row.id, row]));
  const deals: BoardDeal[] = rows.map((row) => {
    const flag = flags.get(row.id);
    return {
      id: row.id,
      stageId: row.stageId,
      code: row.code,
      title: row.title,
      clientCode: row.clientCode,
      clientName: row.clientName,
      ownerName: row.ownerName,
      quotedAmount: row.quotedAmount,
      quotedCurrency: row.quotedCurrency,
      quotedVolumeM3: row.quotedVolumeM3,
      quotedWeightKg: row.quotedWeightKg,
      deferred: row.deferred,
      flag: (flag?.reason as 'deviation' | 'unpriced' | undefined) ?? null,
      flagPct: flag?.pct ?? null,
      chat: badges.get(row.clientId) ?? null,
    };
  });

  const advancedLabels = {
    filters: tc('boardFilters'),
    source: tc('source'),
    dateFrom: tc('filterFrom'),
    dateTo: tc('filterTo'),
    price: t('amount'),
    volume: t('volumeM3'),
    weight: t('weightKg'),
    lentaSearch: tc('filterLenta'),
    min: tc('filterMin'),
    max: tc('filterMax'),
  };
  // Every chip counts — the scope chip too, or the row renders unpaid and
  // eats 28px off the board's bottom (the geometry fence caught exactly this).
  const chipsOn =
    params.scope === 'all' || Boolean(q) || Boolean(hodim) || Object.keys(filters.raw).length > 0;

  return (
    // The board's height is a viewport calculation, so anything added ABOVE it
    // has to say how much room it took or the page grows a second scrollbar
    // under a board that was built not to have one (#354). Round 72 collapsed
    // the header / scope tabs / view chips / filter card into ONE toolbar row;
    // the attention fold and the chips row pay for themselves when present.
    <div
      className="space-y-2"
      style={{
        ['--board-extra' as string]: `${
          3.25 + (chipsOn ? 2.5 : 0) + (attention.length > 0 ? 3 : 0)
        }rem`,
      }}
    >
      {/* `relative` on the ROW — every popover anchors to it (#471); a
          PopoverRow so opening one fold closes the others. */}
      <PopoverRow className="relative flex items-center gap-1.5">
        <h1 className="min-w-0 flex-1 truncate text-lg">{t('title')}</h1>
        <InlineSearch
          q={q}
          label={tcommon('search')}
          carried={{
            ...(params.scope === 'all' ? { scope: 'all' } : {}),
            ...(hodim ? { hodim } : {}),
            ...(archive ? { arxiv: '1' } : {}),
            ...filters.raw,
          }}
        />
        {/* The other half of the sales story, in sight — only for somebody
            the lead funnel would actually let in. */}
        {actor.permissions.has('crm.leads') && (
          <Link
            href="/crm"
            className="btn-secondary btn-icon"
            data-testid="to-leads"
            aria-label={tc('funnel')}
          >
            <Icon name="target" className="h-4 w-4" />
          </Link>
        )}
        <BoardFilter
          q={q}
          scope={params.scope === 'all' ? 'all' : ''}
          hodim={hodim}
          people={managers.map((row) => ({ id: row.id, fullName: row.fullName }))}
          // The form REPLACES the URL (#171); arxiv is the one param that
          // lives outside it.
          hidden={archive ? { arxiv: '1' } : {}}
          labels={{
            search: tcommon('search'),
            whose: tc('whoseWork'),
            mine: t('mine'),
            all: t('all'),
            everyone: tc('allManagers'),
            apply: tcommon('search'),
            clear: tc('filterClear'),
          }}
          advanced={{ values: filters.raw, labels: advancedLabels }}
        />
        {/* The board's query string is already a view; a name makes it a door. */}
        <ViewsMenu
          screen="bitimlar"
          path="/bitimlar"
          views={views}
          currentQuery={normalizeQuery(raw)}
          canPublish={canPublishViews(actor.permissions)}
          label={tl('views')}
        />
        <BoardMenu label={tcommon('moreActions')}>
          {/* The funnel's own settings — cargo triggers live there. Gated
              like the lead settings: reshaping columns is crm.manage. */}
          {actor.permissions.has('crm.manage') && (
            <Link href="/bitimlar/etaplar" className={boardMenuItem} data-testid="deal-stage-settings">
              <Icon name="settings" className="h-4 w-4 text-ink-500" />
              {t('stageSettings')}
            </Link>
          )}
          <CardFieldsMenu
            inline
            board="deal"
            specs={DEAL_CARD_FIELDS}
            chosen={cardFields}
            labels={{
              title: t('cardFields'),
              save: tcommon('save'),
              field: (key) => t(key as 'amount'),
            }}
          />
        </BoardMenu>
        <Link href="/bitimlar/new" className="btn-primary" data-testid="new-deal" aria-label={t('newDeal')}>
          <Icon name="plus" className="h-4 w-4" />
          <span className="hidden sm:inline">{t('newDeal')}</span>
        </Link>
      </PopoverRow>

      <BoardChips
        q={q}
        scope={params.scope === 'all' ? 'all' : ''}
        hodim={hodim}
        hodimName={managers.find((row) => row.id === hodim)?.fullName ?? null}
        values={filters.raw}
        labels={{ ...advancedLabels, search: tcommon('search'), all: t('all') }}
        current={{ ...carried, ...(archive ? { arxiv: '1' } : {}) }}
      />

      {/* Above the board on purpose — «what is on fire» is the reason to open
          this screen — but FOLDED to one line (round 72): eight warning cards
          were pushing the board itself below the fold, and the board is what
          the owner asked to see. */}
      {attention.length > 0 && (
        <details className="card !p-0" data-testid="deal-attention">
          <summary className="cursor-pointer list-none px-3 py-2 text-sm font-bold text-bad marker:content-none">
            ⚠️ {t('attention')} · {attention.length}
          </summary>
          <div className="space-y-1 border-t border-line p-2">
            {attention.slice(0, 8).map((row) => (
              <Link
                key={row.id}
                href={`/bitimlar/${row.id}`}
                className="card block !p-2.5 hover:bg-surface-sunken"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="num text-xs font-bold text-ink-500">{row.code}</span>
                  <span className="num font-bold text-good">{row.clientCode}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{row.clientName}</span>
                  <span className="text-xs font-bold text-bad">
                    {row.reason === 'unpriced'
                      ? t('unpriced')
                      : `${row.pct !== null && row.pct > 0 ? '+' : ''}${row.pct?.toFixed(0)} % · ${t('deviation')}`}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </details>
      )}

      <DealBoard
        stages={stages}
        deals={deals}
        fields={cardFields}
        hidden={hidden}
        archiveHref={`/bitimlar${hrefWith(carried, { arxiv: '1' })}`}
      />
    </div>
  );
}
