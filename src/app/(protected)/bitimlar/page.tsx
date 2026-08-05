import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { chatBadges, tgViewerFor } from '@/modules/wms/crm/conversations';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page';
import { BoardFilter, hrefWith } from '@/components/list/board-filter';
import { salesManagerOptions } from '@/modules/platform/rbac/queries';
import {
  canWriteDeal,
  closedDealCounts,
  dealsNeedingAttention,
  listDeals,
  listStages,
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
  searchParams: Promise<{ scope?: string; arxiv?: string; q?: string; hodim?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!canWriteDeal(actor.permissions)) redirect('/');
  const t = await getTranslations('deals');
  const tc = await getTranslations('crm');
  const tcommon = await getTranslations('common');
  const params = await searchParams;

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
  };

  // Same rule as the lead funnel (round 47, owner's item 6): the won and lost
  // columns keep the recent cards and say how many more they hold. A closed
  // job is a record; a board is a list of work.
  const archive = params.arxiv === '1';
  const [stages, open, closed, closedTotals, attention, badges, managers] = await Promise.all([
    listStages(),
    listDeals({ ownerId: scope, q, openOnly: true }),
    listDeals({ ownerId: scope, q, closedOnly: true, limit: archive ? 400 : CLOSED_ON_BOARD }),
    // The SAME q as the rows, or the «+N · show all» footer lies.
    closedDealCounts(scope, q),
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
  for (const row of closed) {
    shownClosed.set(row.stageId, (shownClosed.get(row.stageId) ?? 0) + 1);
  }
  const hidden = Object.fromEntries(
    Object.entries(closedTotals)
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
      deferred: row.deferred,
      flag: (flag?.reason as 'deviation' | 'unpriced' | undefined) ?? null,
      flagPct: flag?.pct ?? null,
      chat: badges.get(row.clientId) ?? null,
    };
  });

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
        icon="handshake"
        title={t('title')}
        actions={
          <>
            {/* The other half of the sales story — see /crm's header. Only
                for somebody the lead funnel would actually let in. */}
            {actor.permissions.has('crm.leads') && (
              <Link
                href="/crm"
                className="btn-secondary px-3"
                data-testid="to-leads"
                aria-label={tc('funnel')}
              >
                <Icon name="target" className="h-4 w-4" />
                {/* Icon only on a phone. Three labelled buttons measured 373 px
                    inside a 360 px screen, and the cheapest of the three to say
                    without words is the door to the OTHER board — its icon is
                    that board's own (round 60's precedent, the language
                    switcher). */}
                <span className="hidden sm:inline">{tc('funnel')}</span>
              </Link>
            )}
            {/* The funnel's own settings — cargo triggers live there. Gated
                like the lead settings: reshaping columns is crm.manage. */}
            {actor.permissions.has('crm.manage') && (
              <Link
                href="/bitimlar/etaplar"
                className="btn-secondary px-3"
                data-testid="deal-stage-settings"
                aria-label={t('stageSettings')}
              >
                <Icon name="settings" className="h-4 w-4" />
              </Link>
            )}
            <Link href="/bitimlar/new" className="btn-primary" data-testid="new-deal">
              <Icon name="plus" className="h-4 w-4" />
              {t('newDeal')}
            </Link>
          </>
        }
      />

      {seesAll && (
        <div className="flex gap-2">
          <Link
            href={`/bitimlar${hrefWith(carried, { scope: undefined })}`}
            className={mine ? 'btn-primary flex-1' : 'btn-secondary flex-1'}
          >
            {t('mine')}
          </Link>
          <Link
            href={`/bitimlar${hrefWith(carried, { scope: 'all' })}`}
            className={mine ? 'btn-secondary flex-1' : 'btn-primary flex-1'}
          >
            {t('all')}
          </Link>
        </div>
      )}

      <BoardFilter
        q={q}
        hodim={hodim}
        people={managers.map((row) => ({ id: row.id, fullName: row.fullName }))}
        hidden={{
          ...(params.scope === 'all' ? { scope: 'all' } : {}),
          ...(archive ? { arxiv: '1' } : {}),
        }}
        labels={{
          search: tcommon('search'),
          everyone: tc('allManagers'),
          apply: tcommon('search'),
          clear: tc('filterClear'),
        }}
      />

      {/* Above the board on purpose. A board answers "where is everything";
          this answers "what is on fire", and that is the reason to open it. */}
      {attention.length > 0 && (
        <section className="space-y-1" data-testid="deal-attention">
          <h2 className="section-title text-bad">
            ⚠️ {t('attention')} · {attention.length}
          </h2>
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
        </section>
      )}

      <DealBoard
        stages={stages}
        deals={deals}
        hidden={hidden}
        archiveHref={`/bitimlar${hrefWith(carried, { arxiv: '1' })}`}
      />
    </div>
  );
}
