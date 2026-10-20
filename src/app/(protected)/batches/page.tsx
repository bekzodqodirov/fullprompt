import Link from 'next/link';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { batches, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { Panel } from '@/components/panel';
import { createQuickBatchAction } from './batch-actions-server';
import { PageHeader } from '@/components/ui/page';
import { hrefWith } from '@/components/list/board-filter';
import { warehouseScopeEither } from '@/modules/platform/rbac/scope';
import { mayReadBatches } from '@/modules/wms/batches/read-door';
import { BOARD_CAP, loadBoard } from '@/modules/wms/batches/board';
import {
  assembleBoard,
  readBoardFilters,
  ROUTE_FILTERS,
  type BoardColumn,
  type BoardSection,
  type RouteFilter,
  type StripStop,
} from '@/modules/wms/batches/board-view';
import { riderLoad } from '@/modules/wms/batches/riders';
import { batchTextMatchSql, formerCodeHitSql } from '@/modules/wms/batches/former-codes';
import { likeNeedle } from '@/modules/wms/search/query';
import { ROAD_ZONES, type RoadZone } from '@/modules/wms/tracking/place';
import { TripCard, TruckCard, ZONE_BAR } from './board-card';
import { StripScroll } from './strip-scroll';

/** Finished work: off the board, but the owner still needs to find it. */
const ARCHIVED = ['unloaded', 'closed', 'cancelled'] as const;

type Params = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * Which radio shows which column below `xl` — ONE DOM, every column
 * rendered, the checked tab showing its own (docs/PARTIYA-DOSKASI.md §3).
 * Literal, so Tailwind compiles every selector (a class built at runtime
 * does not exist); the `:has()` selector outranks the column's `hidden`.
 */
const TAB_SHOWS =
  '[&:has(#bt-forming:checked)_[data-col=forming]]:block [&:has(#bt-loading:checked)_[data-col=loading]]:block [&:has(#bt-road:checked)_[data-col=road]]:block [&:has(#bt-arrived:checked)_[data-col=arrived]]:block';

/**
 * Partiya doskasi — every open truck and factory trip in one place, by WHERE
 * they are (his 1A 2a 3a, 2026-10-17): the four columns, sections by place
 * inside them, the road strip of counts on top, and the archive drawer below
 * (a batch used to vanish once unloaded, with no way back to its papers).
 */
export default async function BatchesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  // The tile promises a permission the page never checked, so the board and
  // the archive were open by URL to everyone. `ved.docs` is in the list on
  // purpose: the customs papers live here and it is the VED manager's job.
  if (!mayReadBatches(actor.permissions)) redirect('/');
  const t = await getTranslations('batches');
  const tb = await getTranslations('batches.board');
  const tp = await getTranslations('place');
  const params = await searchParams;
  const q = first(params.q)?.trim() ?? '';
  const archiveOpen = first(params.archive) === '1' || q !== '';
  const canQuick = actor.permissions.has('batches.depart_close');
  const activeWhs = await db
    .select({
      id: warehouses.id,
      code: warehouses.code,
      allowsQuickBatch: warehouses.allowsQuickBatch,
    })
    .from(warehouses)
    .where(eq(warehouses.active, true))
    .orderBy(warehouses.code);
  // The viewer's own warehouses: what the quick truck may start from and
  // what `?sklad=` may name (a uuid of a warehouse they cannot see is
  // dropped, never echoed back).
  const ownWhs = actor.warehouseScoped ? activeWhs.filter((wh) => actor.warehouseIds.includes(wh.id)) : activeWhs;
  // A warehouse worker loads from THEIR warehouse and nowhere else (owner:
  // "faqat o'zinikini belgilasin"), and only from a warehouse allowed to start
  // a truck with no plan (owner, round 89: not from Kashgar). The DESTINATION
  // list is untouched — sending cargo somewhere else is the whole point.
  const originWhs = ownWhs.filter((wh) => wh.allowsQuickBatch);

  const filters = readBoardFilters(params, ownWhs.map((wh) => wh.id));
  const [board, archived] = await Promise.all([
    loadBoard(actor),
    archiveOpen ? listArchive(actor, q || undefined) : Promise.resolve([]),
  ]);
  const view = assembleBoard(board.cards, filters);
  const current: Record<string, string> = {};
  if (filters.sklad) current.sklad = filters.sklad;
  if (filters.yonalish) current.yonalish = filters.yonalish;
  if (filters.ogoh) current.ogoh = '1';
  if (filters.joy) current.joy = filters.joy;
  const filtered = Object.keys(current).length > 0;
  // The fold's badge counts what the form sets; the place (`joy`) is the strip's.
  const filterCount = [filters.sklad, filters.yonalish, filters.ogoh ? '1' : null].filter(Boolean).length;

  // Literal maps — a key built from a value escapes the i18n tripwire (#163).
  const COLUMN_LABEL: Record<BoardColumn, string> = {
    forming: t('statuses.forming'),
    loading: t('statuses.loading'),
    road: t('statuses.in_transit'),
    arrived: t('statuses.arrived'),
  };
  const ROAD: Record<RoadZone, string> = {
    cn: tp('road.cn'),
    border: tp('road.border'),
    transit: tp('road.transit'),
    uz: tp('road.uz'),
  };
  const WAREHOUSE: Record<Exclude<RoadZone, 'transit'>, string> = {
    cn: tp('wh.cn'),
    border: tp('wh.border'),
    uz: tp('wh.uz'),
  };
  const STOP_LABEL: Record<StripStop, string> = {
    forming: t('statuses.forming'),
    loading: t('statuses.loading'),
    road_cn: ROAD.cn,
    road_border: ROAD.border,
    road_transit: ROAD.transit,
    road_uz: ROAD.uz,
    road_unknown: tp('unknown'),
    arrived: t('statuses.arrived'),
  };
  const ROUTE_LABEL: Record<RouteFilter, string> = {
    irkeshtam: tb('route.irkeshtam'),
    horgos: tb('route.horgos'),
    ichki: tb('route.ichki'),
  };
  // A warehouse is never «in transit», so that word is the road's alone.
  const sectionLabel = (column: BoardColumn, section: BoardSection) =>
    section === 'unknown'
      ? tp('unknown')
      : section === 'transit' || column === 'road'
        ? ROAD[section]
        : WAREHOUSE[section];

  return (
    <div className="space-y-4">
      <PageHeader
        icon="truck"
        title={t('title')}
        actions={
          <>
            <Link href="/map" className="btn-secondary px-3 text-sm" data-testid="board-map-link">
              🗺 {tb('mapLink')}
            </Link>
            <Link href="/transit" className="btn-secondary px-3 text-sm">
              🔍 {t('transitReport')}
            </Link>
          </>
        }
      />

      {canQuick && originWhs.length > 0 && (
        <form action={createQuickBatchAction} className="card flex flex-wrap items-center gap-2 !p-3">
          <span className="text-sm font-bold">⚡ {t('quickBatch')}</span>
          {originWhs.length === 1 ? (
            // One warehouse, no choice to make: show it and send it.
            <>
              <input type="hidden" name="originId" value={originWhs[0]!.id} />
              <span
                data-testid="quick-origin-fixed"
                className="input !w-24 flex items-center font-mono font-bold"
              >
                {originWhs[0]!.code}
              </span>
            </>
          ) : (
            <select
              name="originId"
              aria-label={t('quickOrigin')}
              className="input !w-24 font-mono font-bold"
              defaultValue={originWhs[0]?.id}
            >
              {originWhs.map((wh) => (
                <option key={wh.id} value={wh.id}>
                  {wh.code}
                </option>
              ))}
            </select>
          )}
          <span className="font-bold">→</span>
          <select
            name="destId"
            aria-label={t('quickDest')}
            className="input !w-24 font-mono font-bold"
            defaultValue={activeWhs.find((wh) => wh.id !== originWhs[0]?.id)?.id}
          >
            {activeWhs.map((wh) => (
              <option key={wh.id} value={wh.id}>
                {wh.code}
              </option>
            ))}
          </select>
          <button type="submit" className="btn-primary flex-1 whitespace-nowrap px-3" data-testid="create-quick-batch">
            ＋ {t('create')}
          </button>
        </form>
      )}

      {/* The road strip (2a): a count per place, every filter but `joy`
          applied; a tap filters the board to that place and a second tap
          lets it go. A stop with nothing at it is plain text. */}
      <StripScroll active={filters.joy} label={tb('strip')}>
        <ul className="flex items-center gap-1.5 whitespace-nowrap">
          {view.strip
            .filter((stop) => stop.stop !== 'road_unknown' || stop.count > 0)
            .map((stop, i) => {
              const active = filters.joy === stop.stop;
              const body = (
                <>
                  <span>{STOP_LABEL[stop.stop]}</span>
                  <b className="tabular-nums">{stop.count}</b>
                  {stop.stop === 'road_transit' && stop.count > 0 && (
                    <span className="text-xs font-normal text-ink-500">
                      ({tp('kg')} {stop.kg} · {tp('kz')} {stop.kz})
                    </span>
                  )}
                </>
              );
              return (
                <li key={stop.stop} className="flex items-center gap-1.5">
                  {i > 0 && (
                    <span aria-hidden className="text-ink-400">
                      ›
                    </span>
                  )}
                  {stop.count > 0 || active ? (
                    <Link
                      href={hrefWith(current, { joy: active ? undefined : stop.stop })}
                      aria-current={active ? 'true' : undefined}
                      data-testid={`board-stop-${stop.stop}`}
                      className={`inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3 text-sm ${
                        active
                          ? 'border-brand-500 bg-brand-50 font-semibold text-brand-800'
                          : 'border-line-strong bg-surface-raised text-ink-900 hover:bg-surface-sunken'
                      }`}
                    >
                      {body}
                    </Link>
                  ) : (
                    <span
                      data-testid={`board-stop-${stop.stop}`}
                      className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-line px-3 text-sm text-ink-400"
                    >
                      {body}
                    </span>
                  )}
                </li>
              );
            })}
        </ul>
      </StripScroll>

      {/* Folded: on a phone the three controls cost a screen before the
          first truck. Open while a filter is on, so what narrows the board
          is never hidden; the strip above stays one tap. */}
      <details open={filterCount > 0} className="group" data-testid="board-filter-fold">
        <summary className="inline-flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-full border border-line-strong bg-surface-raised px-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          ⚲ {tb('filters')}
          {filterCount > 0 && <b className="rounded-full bg-brand-600 px-1.5 text-xs text-white">{filterCount}</b>}
        </summary>
        <form method="get" className="mt-2 flex flex-wrap items-center gap-2" data-testid="board-filters">
          {filters.joy && <input type="hidden" name="joy" value={filters.joy} />}
          {ownWhs.length > 1 && (
            <select
              name="sklad"
              aria-label={tb('filterWarehouse')}
              defaultValue={filters.sklad ?? ''}
              className="input !w-auto"
            >
              <option value="">
                {tb('filterWarehouse')}: {tb('filterAll')}
              </option>
              {ownWhs.map((wh) => (
                <option key={wh.id} value={wh.id}>
                  {wh.code}
                </option>
              ))}
            </select>
          )}
          <select
            name="yonalish"
            aria-label={tb('filterRoute')}
            defaultValue={filters.yonalish ?? ''}
            className="input !w-auto"
          >
            <option value="">
              {tb('filterRoute')}: {tb('filterAll')}
            </option>
            {ROUTE_FILTERS.map((route) => (
              <option key={route} value={route}>
                {ROUTE_LABEL[route]}
              </option>
            ))}
          </select>
          <label className="flex min-h-12 items-center gap-2 text-sm">
            <input type="checkbox" name="ogoh" value="1" defaultChecked={filters.ogoh} className="h-5 w-5" />
            {tb('filterWarnings')}
          </label>
          <button type="submit" className="btn-secondary px-4">
            {tb('filterApply')}
          </button>
          {filtered && (
            <Link href="/batches" className="flex min-h-12 items-center px-2 text-sm font-semibold text-brand-700">
              {tb('filterClear')}
            </Link>
          )}
        </form>
      </details>

      {board.capped && (
        <p role="status" className="text-sm font-semibold text-warn">
          {tb('capped', { n: BOARD_CAP })}
        </p>
      )}
      {board.cards.length === 0 && <p className="text-sm text-ink-500">{tb('emptyBoard')}</p>}

      {/* Keyed by the tab it opens on, so a strip tap — a soft navigation —
          remounts the radios and the new default is the one checked. */}
      <div key={`tabs:${view.activeColumn}`} data-testid="batch-board" className={TAB_SHOWS}>
        <div
          role="radiogroup"
          aria-label={tb('tabs')}
          className="mb-3 grid grid-cols-4 gap-1 rounded-xl bg-surface-sunken p-1 xl:hidden"
        >
          {view.columns.map((column) => (
            <label key={column.key} className="min-w-0 cursor-pointer">
              <input
                type="radio"
                name="board-tab"
                id={`bt-${column.key}`}
                value={column.key}
                defaultChecked={column.key === view.activeColumn}
                className="peer sr-only"
                data-testid={`board-tab-${column.key}`}
              />
              <span className="flex min-h-11 flex-col items-center justify-center rounded-lg px-1 text-center text-xs font-semibold text-ink-500 peer-checked:bg-surface-raised peer-checked:text-ink-900 peer-checked:shadow-card peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500">
                <span className="w-full truncate">{COLUMN_LABEL[column.key]}</span>
                <span className="tabular-nums">{column.count}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="grid gap-3 xl:grid-cols-4">
          {view.columns.map((column) => (
            <section
              key={column.key}
              data-col={column.key}
              data-testid={`board-col-${column.key}`}
              className="hidden min-w-0 space-y-3 xl:block"
            >
              <h2 className="hidden text-sm font-bold uppercase tracking-wide text-ink-500 xl:block">
                {COLUMN_LABEL[column.key]} · <span className="tabular-nums">{column.count}</span>
              </h2>
              {column.key === 'road' && column.count > 0 && (
                <p aria-hidden className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-ink-500">
                  {ROAD_ZONES.map((zone) => (
                    <span key={zone} className="inline-flex items-center gap-1">
                      <span className={`h-2 w-3 rounded-sm ${ZONE_BAR[zone]}`} />
                      {ROAD[zone]}
                    </span>
                  ))}
                </p>
              )}
              {column.sections.length === 0 && <p className="text-sm text-ink-400">{tb('empty')}</p>}
              {column.sections.map((section) => (
                <div key={section.key} className="space-y-2" data-testid={`board-section-${column.key}-${section.key}`}>
                  <h3 className="section-title">
                    {sectionLabel(column.key, section.key)} · {section.cards.length}
                  </h3>
                  {section.cards.map((card) =>
                    card.type === 'batch' ? (
                      <TruckCard key={card.key} card={card} />
                    ) : (
                      <TripCard key={card.key} card={card} />
                    ),
                  )}
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>

      <Panel title={`🗄 ${t('archive')}`} open={archiveOpen}>
        <form method="get" className="flex gap-2">
          <input type="hidden" name="archive" value="1" />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder={t('archiveSearch')}
            className="input flex-1"
          />
          <button type="submit" className="btn-primary px-4">
            🔍
          </button>
        </form>
        {archiveOpen && archived.length === 0 && (
          <p className="text-sm text-ink-500">{t('archiveEmpty')}</p>
        )}
        {archived.map(({ batch, originCode, destCode, boxCount, formerCode }) => (
          <Link
            key={batch.id}
            href={`/batches/${batch.id}`}
            data-testid="batch-archive-row"
            className="flex flex-wrap items-baseline gap-2 border-b border-line py-2 text-sm last:border-0 hover:bg-surface-sunken"
          >
            <span className="font-mono font-extrabold text-brand-700">{batch.code}</span>
            {formerCode && (
              <span className="text-xs text-ink-500" data-testid="batch-archive-former">
                {t('rename.formerHit', { code: formerCode })}
              </span>
            )}
            <span className="font-mono">
              {originCode} → {destCode}
            </span>
            <span>{boxCount} 📦</span>
            {batch.vehiclePlate && <span className="text-ink-500">🚛 {batch.vehiclePlate}</span>}
            <span className="ml-auto text-xs text-ink-500">
              {t(`statuses.${batch.status}`)}
              {batch.closedAt ? ` · ${batch.closedAt.toISOString().slice(0, 10)}` : ''}
            </span>
          </Link>
        ))}
      </Panel>
    </div>
  );
}

/**
 * The archive: finished trucks, newest first, matched by ⌘K's own fragment
 * (code, plate, driver, any name the truck used to wear). The box count is
 * what RODE (`riderLoad`) — the board's own number, so a truck reads the
 * same figure the day before and the day after it is unloaded.
 */
async function listArchive(
  actor: { warehouseScoped: boolean; warehouseIds: string[] },
  search: string | undefined,
) {
  const dest = aliasedTable(warehouses, 'dest');
  const rows = await db
    .select({
      batch: batches,
      originCode: warehouses.code,
      destCode: dest.code,
      // Which old name matched — the archive is where a name printed on
      // old papers is looked up (the owner's 1a: a truck renamed on the road).
      formerCode: search ? formerCodeHitSql(likeNeedle(search)) : sql<string | null>`NULL`,
    })
    .from(batches)
    .innerJoin(warehouses, eq(batches.originWarehouseId, warehouses.id))
    .innerJoin(dest, eq(batches.destWarehouseId, dest.id))
    .where(
      and(
        warehouseScopeEither(actor, batches.originWarehouseId, batches.destWarehouseId),
        inArray(batches.status, [...ARCHIVED]),
        // One bracketed fragment, so the warehouse fence above binds to every
        // alternative; the needle is escaped (a «%» used to match all).
        search ? batchTextMatchSql(likeNeedle(search)) : undefined,
      ),
    )
    .orderBy(desc(batches.createdAt))
    .limit(100);
  const rode = await riderLoad(rows.map((r) => r.batch.id));
  return rows.map((r) => ({ ...r, boxCount: rode.get(r.batch.id)?.boxCount ?? 0 }));
}
