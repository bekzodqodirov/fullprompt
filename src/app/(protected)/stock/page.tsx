import Link from 'next/link';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  boxes,
  clients,
  receiptLots,
  receipts,
  warehouses,
} from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { getSetting } from '@/modules/platform/settings/service';
import { DensityBadge } from '@/components/density-badge';
import { LightboxImg } from '@/components/lightbox-img';
import { SortTh, sortRows } from '@/components/sort-th';
import { warehouseScope } from '@/modules/platform/rbac/scope';
import { parseCols, visibleColumns } from '@/modules/platform/lists/columns';
import { canPublishViews, normalizeQuery } from '@/modules/platform/lists/query';
import { defaultViewFor, listViewsFor } from '@/modules/platform/lists/service';
import { ViewBar } from '@/components/list/view-bar';
import { ColumnPicker } from '@/components/list/column-picker';
import { STOCK_COLUMNS } from '@/modules/wms/inventory/columns';
import { transitTrucks } from '@/modules/wms/inventory/service';
import { codeIdentity } from '@/modules/wms/labels/code-identity';

/** Owner's request: order the stock table by any column, filters kept. */
const SORTABLE = STOCK_COLUMNS.map((column) => column.key);

/**
 * How many lot×warehouse rows the TABLE loads (round 74).
 *
 * The sort keys people use here — Σ kg, m³, density — are derived per row, so
 * the sort has to happen after the fetch and the fetch needs a ceiling (round
 * 68 rejected SQL paging for exactly this reason). Raised from 500 because at
 * 50 receipts a day the steady state is ~700 concurrent rows; the Σ header and
 * the row count no longer come from this array, so exceeding it costs
 * completeness of the TABLE and nothing else — and the screen says so.
 */
const STOCK_FETCH_CAP = 2000;

/** Stock browser v1 (spec §10 screen 6): WH → client → lot → box. */
export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{
    wh?: string;
    client?: string;
    lot?: string;
    q?: string;
    sort?: string;
    dir?: string;
    cols?: string;
    page?: string;
  }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('stock');
  // No namespace: a ColumnDef carries its full key, so one call resolves the
  // labels of any column list this screen renders.
  const tAny = await getTranslations();
  const format = await getFormatter();
  const params = await searchParams;

  // A personal default view applies on a BARE visit only, and by redirecting:
  // the address bar then matches the screen, so every sort link and the export
  // carry the same state (the client book does this too).
  if (Object.keys(params).length === 0) {
    const preset = await defaultViewFor('stock', actor.id);
    if (preset?.query) redirect(`/stock?${preset.query}`);
  }

  // Everything physically ON the shelf counts as stock — including boxes
  // reserved for a plan, mid-loading, or unloaded at a customs/distribution
  // warehouse as ready_for_pickup (owner's report: "13 boxes at TAS1 but the
  // stock page shows nothing"). Each box row still shows its exact status.
  const scopeFilter: SQL[] = [
    inArray(boxes.status, ['in_stock', 'planned', 'loading', 'ready_for_pickup']),
  ];
  const boxScope = warehouseScope(actor, boxes.currentWarehouseId);
  if (boxScope) scopeFilter.push(boxScope);
  if (params.wh) scopeFilter.push(eq(boxes.currentWarehouseId, params.wh));

  // Lot drill-down: box list
  if (params.lot) {
    const boxRows = await db
      .select()
      .from(boxes)
      // The list above is scoped and this branch was not: a lot id in the URL
      // showed another warehouse's boxes.
      .where(boxScope ? and(eq(boxes.lotId, params.lot), boxScope) : eq(boxes.lotId, params.lot))
      .orderBy(asc(boxes.seqInLot));
    const lot = await db.query.receiptLots.findFirst({ where: eq(receiptLots.id, params.lot) });
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-bold">
          {lot?.letter} — {lot?.productNameZh} {lot?.productNameRu && `(${lot.productNameRu})`}
        </h1>
        <div className="space-y-1">
          {boxRows.map((box) => (
            <Link
              key={box.id}
              href={`/boxes/${box.id}`}
              className="card flex items-baseline gap-2 !p-3 hover:bg-surface-sunken"
            >
              <span className="font-mono font-bold">{box.shortCode}</span>
              <span className="text-sm text-ink-500">
                {box.seqInLot}/{lot?.boxCount}
              </span>
              <span className="ml-auto rounded bg-surface-sunken px-2 py-0.5 text-xs font-semibold">
                {t(`statuses.${box.status}`)}
              </span>
            </Link>
          ))}
        </div>
      </div>
    );
  }

  // Client drill-down: lots with in-stock boxes
  if (params.client) {
    const client = await db.query.clients.findFirst({ where: eq(clients.id, params.client) });
    const lotRows = await db
      .select({
        lot: receiptLots,
        receiptNumber: receipts.number,
        whCode: warehouses.code,
        inStock: sql<number>`count(*)`,
      })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .innerJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
      .where(and(...scopeFilter, eq(receipts.clientId, params.client)))
      .groupBy(receiptLots.id, receipts.number, warehouses.code)
      .orderBy(asc(receipts.number));
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-bold">
          <span className="font-mono text-brand-700">{client?.clientCode}</span> — {client?.name}
        </h1>
        <div className="space-y-1">
          {lotRows.map(({ lot, receiptNumber, whCode, inStock }) => (
            <Link
              // Same reason as the table below: grouped by lot AND warehouse.
              key={`${lot.id}-${whCode}`}
              href={`/stock?lot=${lot.id}`}
              className="card block !p-3 hover:bg-surface-sunken"
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-lg font-extrabold text-brand-700">{lot.letter}</span>
                <span>
                  {lot.productNameZh} {lot.productNameRu && `(${lot.productNameRu})`}
                </span>
                <span className="ml-auto text-sm font-semibold">
                  {inStock} {t('boxes')}
                </span>
              </div>
              <p className="text-xs text-ink-500">
                {whCode} · {receiptNumber} · {lot.totalWeightKg} kg · {lot.totalVolumeM3} m³
              </p>
            </Link>
          ))}
        </div>
      </div>
    );
  }

  // Top level: Excel-like line table (owner's Kashgar file layout) — one row
  // per lot with in-stock boxes: photo, code+letter, product, counts, kg, m³,
  // density, pieces, WH, date.
  if (params.q) {
    scopeFilter.push(
      sql`(${clients.clientCode} ILIKE ${'%' + params.q + '%'} OR ${receiptLots.productNameZh} ILIKE ${'%' + params.q + '%'} OR ${receiptLots.productNameRu} ILIKE ${'%' + params.q + '%'} OR ${receipts.unclaimedMarking} ILIKE ${'%' + params.q + '%'})`,
    );
  }
  // The trucks on the road (round 100, owner's 5A). Its own query with its
  // own scope: `scopeFilter` is built on `currentWarehouseId`, which is NULL
  // for every in-transit box — reusing it would answer zero for ever.
  const onRoad = await transitTrucks(actor, params.wh);
  const lines = await db
    .select({
      lot: receiptLots,
      receiptId: receipts.id,
      receivedAt: receipts.receivedAt,
      marking: receipts.unclaimedMarking,
      whCode: warehouses.code,
      clientId: clients.id,
      clientCode: clients.clientCode,
      inStock: sql<number>`count(*)`,
      photoId: sql<string | null>`(
        SELECT a.id FROM attachments a
        WHERE a.entity_type = 'receipt_lot' AND a.entity_id = ${receiptLots.id} AND a.kind = 'photo'
        ORDER BY a.created_at LIMIT 1
      )`,
      generalPhotoId: sql<string | null>`(
        SELECT a.id FROM attachments a
        WHERE a.entity_type = 'receipt' AND a.entity_id = ${receipts.id} AND a.kind = 'photo'
        ORDER BY a.created_at LIMIT 1
      )`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .innerJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(and(...scopeFilter))
    .groupBy(
      receiptLots.id,
      receipts.id,
      receipts.receivedAt,
      receipts.unclaimedMarking,
      warehouses.code,
      clients.id,
      clients.clientCode,
    )
    .orderBy(asc(warehouses.code), asc(receipts.receivedAt))
    .limit(STOCK_FETCH_CAP);

  // The Σ header and the row count describe THE WAREHOUSE, not the fetch
  // (round 74). They used to reduce the fetched array, so once the cap bit —
  // measured at ~700 concurrent lot×warehouse rows for 50 receipts a day
  // against a cap of 500 — the totals silently shrank to whatever had been
  // loaded, and the XLSX (a 10,000 cap) printed a different number for the
  // same filter. One grouped aggregate, the SAME predicate, so the two can
  // never disagree again.
  const [totals] = await db
    .select({
      lines: sql<number>`count(*)`,
      boxes: sql<number>`coalesce(sum(g.in_stock), 0)`,
      kg: sql<number>`coalesce(sum(g.in_stock * g.weight_per_box), 0)`,
      m3: sql<number>`coalesce(sum(g.in_stock * g.volume_per_box), 0)`,
    })
    .from(
      db
        .select({
          inStock: sql<number>`count(*)`.as('in_stock'),
          weightPerBox: sql<number>`${receiptLots.totalWeightKg} / ${receiptLots.boxCount}`.as(
            'weight_per_box',
          ),
          volumePerBox: sql<number>`${receiptLots.totalVolumeM3} / ${receiptLots.boxCount}`.as(
            'volume_per_box',
          ),
        })
        .from(boxes)
        .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
        .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
        .innerJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
        .leftJoin(clients, eq(receipts.clientId, clients.id))
        .where(and(...scopeFilter))
        .groupBy(receiptLots.id, receipts.id, warehouses.code)
        .as('g'),
    );

  const allWhs = await db
    .select({ id: warehouses.id, code: warehouses.code })
    .from(warehouses)
    .orderBy(asc(warehouses.code));
  const densityThresholds = await getSetting('density_thresholds');

  // Flatten first: the numbers the owner sorts by (Σ kg, m³, density) are
  // derived per row, so they have to exist before sortRows can order them.
  const rows = lines.map((line) => {
    const perBoxKg = Number(line.lot.totalWeightKg) / line.lot.boxCount;
    const boxCount = Number(line.inStock);
    return {
      line,
      // The printed code first (round 98); the export names the client in its
      // own column, so the code cell is the box's marking where there is one.
      code: `${codeIdentity(line.marking, line.clientCode).main}-${line.lot.letter}`,
      product: `${line.lot.productNameZh} ${line.lot.productNameRu ?? ''}`.trim(),
      boxes: boxCount,
      perBoxKg,
      stockKg: perBoxKg * boxCount,
      stockM3: (Number(line.lot.totalVolumeM3) / line.lot.boxCount) * boxCount,
      density:
        Number(line.lot.totalVolumeM3) > 0
          ? Number(line.lot.totalWeightKg) / Number(line.lot.totalVolumeM3)
          : null,
      note: line.lot.note ?? '',
      whCode: line.whCode,
      receivedAt: line.receivedAt,
    };
  });
  const sorted = sortRows(rows, params.sort, params.dir, SORTABLE);
  // The RENDER is paged and the FETCH is capped; the Σ header and the row
  // count come from the aggregate above, so they describe everything the
  // filter matched whether or not the cap bit. What the page cap buys is the
  // phone: ~450 rows with a photo each are ~10,000 DOM nodes, and a warehouse
  // phone spent 3+ seconds of main-thread time laying them out — the
  // «qotish». 120 rows are one screenful of scrolling.
  const PAGE_ROWS = 120;
  const page = Math.max(1, Math.floor(Number(params.page)) || 1);
  const pageRows = sorted.slice((page - 1) * PAGE_ROWS, page * PAGE_ROWS);
  const pageHref = (target: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '' && key !== 'page') search.set(key, value);
    }
    if (target > 1) search.set('page', String(target));
    const qs = search.toString();
    return qs ? `/stock?${qs}` : '/stock';
  };
  const chosen = parseCols(params.cols);
  const columns = visibleColumns(STOCK_COLUMNS, chosen, (permission) =>
    actor.permissions.has(permission),
  );
  const sortParams = { wh: params.wh, q: params.q, cols: params.cols };
  const currentQuery = normalizeQuery(params as Record<string, string | undefined>);
  const views = await listViewsFor('stock', actor.id);
  const label = (column: (typeof STOCK_COLUMNS)[number]) => column.label ?? tAny(column.labelKey!);
  const exportQuery = new URLSearchParams();
  if (params.wh) exportQuery.set('wh', params.wh);
  if (params.q) exportQuery.set('q', params.q);
  if (params.cols) exportQuery.set('cols', params.cols);
  if (params.sort) exportQuery.set('sort', params.sort);
  if (params.dir) exportQuery.set('dir', params.dir);

  const sumBoxes = Number(totals?.boxes ?? 0);
  const sumKg = Number(totals?.kg ?? 0);
  const sumM3 = Number(totals?.m3 ?? 0);
  const totalLines = Number(totals?.lines ?? rows.length);
  // Said out loud rather than left to be discovered: beyond the cap the TABLE
  // is a slice, while the Σ above it and the export are not.
  const truncated = totalLines > rows.length;

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold">{t('title')}</h1>

      <ViewBar
        screen="stock"
        path="/stock"
        views={views}
        currentQuery={currentQuery}
        canPublish={canPublishViews(actor.permissions)}
      />

      <form method="get" className="relative flex flex-wrap gap-2">
        {params.cols && <input type="hidden" name="cols" value={params.cols} />}
        {/* The warehouse and the search share a line of their OWN. Wrapping
            them into the same row as the buttons left the search box about
            50 px wide on a phone — the `.input` cascade again (#419): a
            flex-1 box next to four fixed-width neighbours gets what is left,
            and on 360 px that is nothing. */}
        <div className="flex w-full gap-2 md:w-auto md:flex-1">
          <select name="wh" className="input !w-28 shrink-0" defaultValue={params.wh ?? ''}>
            <option value="">{t('allWh')}</option>
            {allWhs.map((wh) => (
              <option key={wh.id} value={wh.id}>
                {wh.code}
              </option>
            ))}
          </select>
          <input
            type="search"
            name="q"
            defaultValue={params.q}
            placeholder={t('filterPlaceholder')}
            className="input min-w-0 flex-1"
          />
        </div>
        <ColumnPicker
          columns={STOCK_COLUMNS.map((column) => ({
            key: column.key,
            label: label(column),
            always: column.always,
          }))}
          visible={columns.map((column) => column.key)}
          query={currentQuery}
        />
        <button type="submit" className="btn-primary">
          🔍
        </button>
        <a
          href={`/api/reports/stock?${exportQuery.toString()}`}
          className="btn-secondary whitespace-nowrap"
          data-testid="stock-xlsx"
          title="XLSX"
        >
          ⬇️ XLSX
        </a>
      </form>

      <p className="text-sm font-semibold text-ink-700">
        Σ {sumBoxes} {t('boxes')} · {Math.round(sumKg)} kg · {Math.round(sumM3 * 100) / 100} m³
        {/* The Σ is the warehouse; beyond the fetch cap the TABLE is not.
            Said out loud — a silently short table reads as missing cargo. */}
        {truncated && (
          <span className="ml-2 font-normal text-warn" data-testid="stock-truncated">
            ⚠ {t('shownOfTotal', { shown: rows.length, total: totalLines })}
          </span>
        )}
      </p>

      {/* What is ON THE ROAD to or from these warehouses (round 100, 5A).
          Deliberately outside the Σ, the table, the sort and the XLSX — those
          agree about the shelf, and a truck is not a shelf. Renders only when
          something is actually driving. */}
      {onRoad.length > 0 && (
        <div className="space-y-1" data-testid="stock-onroad">
          <p className="text-xs font-semibold text-ink-500">🚛 {t('onRoad')}</p>
          <div className="flex flex-wrap gap-2">
            {onRoad.map((truck) => (
              <Link
                key={truck.id}
                href={`/batches/${truck.id}`}
                className="card-tap block !py-1.5 px-3 text-sm"
              >
                <span className="font-mono font-bold text-brand-700">{truck.code}</span>{' '}
                <span className="text-ink-500">
                  {truck.originCode}→{truck.destCode}
                </span>{' '}
                · {truck.boxCount} 📦 · {truck.kg} kg · {truck.m3} m³
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-line bg-surface-raised">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-line-strong bg-surface-sunken text-left">
              {columns.map((column) =>
                column.key === 'photo' ? (
                  <th key={column.key} className="p-2">
                    {column.label}
                  </th>
                ) : (
                  <SortTh
                    key={column.key}
                    label={label(column)}
                    field={column.key}
                    sort={params.sort}
                    dir={params.dir}
                    params={sortParams}
                    className={column.numeric ? 'p-2 text-right' : 'p-2'}
                  />
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => (
              // The key carries the WAREHOUSE too. The query groups by lot AND
              // warehouse, so a lot whose boxes sit in two places is two rows —
              // three lots on the owner's own data — and keying them both on
              // the lot id gave React two children with one key, which it is
              // free to duplicate or omit.
              <tr
                key={`${row.line.lot.id}-${row.line.whCode}`}
                className="border-b border-line hover:bg-surface-sunken"
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cellClass(column.key, column.numeric)}
                    title={column.key === 'note' ? (row.line.lot.note ?? '') : undefined}
                  >
                    {column.key === 'photo' ? (
                      <div className="flex items-center gap-1">
                        {/* Bigger than they were (owner: «rasimlar kichkina»).
                            The table scrolls sideways inside its own box, so on
                            a phone every column is already being read at arm's
                            length — a 56 px thumbnail told nobody what was in
                            the box. Tap still opens the full photo. */}
                        {row.line.photoId ? (
                          <LightboxImg
                            attachmentId={row.line.photoId}
                            className="h-20 w-20 rounded-lg object-cover"
                          />
                        ) : (
                          <span className="text-ink-400">—</span>
                        )}
                        {row.line.generalPhotoId && (
                          <LightboxImg
                            attachmentId={row.line.generalPhotoId}
                            testId="general-photo"
                            className="h-20 w-20 rounded-lg border-2 border-warn/40 object-cover"
                          />
                        )}
                      </div>
                    ) : column.key === 'code' ? (
                      <Link
                        href={`/stock?lot=${row.line.lot.id}`}
                        className="font-mono font-extrabold text-brand-700"
                      >
                        {/* The MARKING is the box's printed code (round 98):
                            it wins, and the claimed client's code sits small
                            beneath it — `GS500MANIKEN-AL` over `gs500`. */}
                        {codeIdentity(row.line.marking, row.line.clientCode).main}-
                        {row.line.lot.letter}
                        {codeIdentity(row.line.marking, row.line.clientCode).sub && (
                          <span className="block font-sans text-2xs font-normal text-ink-500">
                            {codeIdentity(row.line.marking, row.line.clientCode).sub}
                          </span>
                        )}
                      </Link>
                    ) : column.key === 'product' ? (
                      <Link href={`/receipts/${row.line.receiptId}`} className="block truncate">
                        {row.line.lot.productNameZh}
                        {row.line.lot.productNameRu && (
                          <span className="text-ink-500"> ({row.line.lot.productNameRu})</span>
                        )}
                      </Link>
                    ) : column.key === 'boxes' ? (
                      row.boxes
                    ) : column.key === 'perBoxKg' ? (
                      Math.round(row.perBoxKg * 10) / 10
                    ) : column.key === 'stockKg' ? (
                      Math.round(row.stockKg)
                    ) : column.key === 'stockM3' ? (
                      Math.round(row.stockM3 * 100) / 100
                    ) : column.key === 'density' ? (
                      <DensityBadge density={row.density} thresholds={densityThresholds} />
                    ) : column.key === 'note' ? (
                      (row.line.lot.note ?? '')
                    ) : column.key === 'whCode' ? (
                      row.line.whCode
                    ) : (
                      format.dateTime(row.line.receivedAt, { dateStyle: 'short' })
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {lines.length === 0 && <p className="p-4 text-sm text-ink-500">{t('empty')}</p>}
      </div>

      {/* The pager, only when there is something beyond the page. Plain links:
          they walk with the back button and a saved view never stores a page
          (CONTROL_PARAMS drops it). */}
      {sorted.length > PAGE_ROWS && (
        <div className="flex items-center justify-between text-sm" data-testid="stock-pager">
          <span className="text-ink-500">
            {t('pageOf', {
              from: (page - 1) * PAGE_ROWS + 1,
              to: Math.min(page * PAGE_ROWS, sorted.length),
              total: totalLines,
            })}
          </span>
          <span className="flex gap-2">
            {page > 1 && (
              <Link href={pageHref(page - 1)} className="btn-secondary !min-h-9 px-3">
                {t('pagePrev')}
              </Link>
            )}
            {page * PAGE_ROWS < sorted.length && (
              <Link
                href={pageHref(page + 1)}
                className="btn-secondary !min-h-9 px-3"
                data-testid="stock-next-page"
              >
                {t('pageNext')}
              </Link>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * The per-column cell class.
 *
 * Kept beside the table rather than on the ColumnDef: these are this screen's
 * typography (a truncating note, a monospaced warehouse code), not facts about
 * what a column IS — another list showing the same column may want neither.
 */
function cellClass(key: string, numeric?: boolean): string {
  if (key === 'photo') return 'p-1.5';
  if (numeric) return key === 'boxes' || key === 'stockKg' ? 'p-2 text-right font-semibold' : 'p-2 text-right';
  if (key === 'code') return 'whitespace-nowrap p-2';
  if (key === 'product') return 'max-w-56 p-2';
  if (key === 'note') return 'max-w-32 truncate p-2 text-xs text-ink-500';
  if (key === 'whCode') return 'p-2 font-mono font-bold';
  if (key === 'receivedAt') return 'whitespace-nowrap p-2 text-ink-500';
  return 'p-2';
}
