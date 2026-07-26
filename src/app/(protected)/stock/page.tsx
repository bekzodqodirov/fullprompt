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
import { LightboxImg } from '@/components/lightbox-img';
import { SortTh, sortRows } from '@/components/sort-th';
import { warehouseScope } from '@/modules/platform/rbac/scope';

/** Owner's request: order the stock table by any column, filters kept. */
const SORTABLE = [
  'code',
  'product',
  'boxes',
  'perBoxKg',
  'stockKg',
  'stockM3',
  'density',
  'note',
  'whCode',
  'receivedAt',
] as const;

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
  }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('stock');
  const format = await getFormatter();
  const params = await searchParams;

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
              key={lot.id}
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
    .limit(500);

  const allWhs = await db
    .select({ id: warehouses.id, code: warehouses.code })
    .from(warehouses)
    .orderBy(asc(warehouses.code));

  // Flatten first: the numbers the owner sorts by (Σ kg, m³, density) are
  // derived per row, so they have to exist before sortRows can order them.
  const rows = lines.map((line) => {
    const perBoxKg = Number(line.lot.totalWeightKg) / line.lot.boxCount;
    const boxCount = Number(line.inStock);
    return {
      line,
      code: `${line.clientCode ?? line.marking ?? '❓'}-${line.lot.letter}`,
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
  const sortParams = { wh: params.wh, q: params.q };

  const sumBoxes = rows.reduce((acc, r) => acc + r.boxes, 0);
  const sumKg = rows.reduce((acc, r) => acc + r.stockKg, 0);
  const sumM3 = rows.reduce((acc, r) => acc + r.stockM3, 0);

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold">{t('title')}</h1>
      <form method="get" className="flex gap-2">
        <select name="wh" className="input !w-28" defaultValue={params.wh ?? ''}>
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
          className="input flex-1"
        />
        <button type="submit" className="btn-primary">
          🔍
        </button>
        <a
          href={`/api/reports/stock?wh=${encodeURIComponent(params.wh ?? '')}&q=${encodeURIComponent(params.q ?? '')}`}
          className="btn-secondary whitespace-nowrap"
          title="XLSX"
        >
          ⬇️ XLSX
        </a>
      </form>

      <p className="text-sm font-semibold text-ink-700">
        Σ {sumBoxes} {t('boxes')} · {Math.round(sumKg)} kg · {Math.round(sumM3 * 100) / 100} m³
      </p>

      <div className="overflow-x-auto rounded-xl border border-line bg-surface-raised">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-line-strong bg-surface-sunken text-left">
              <th className="p-2">📷</th>
              <SortTh label={t('colCode')} field="code" sort={params.sort} dir={params.dir} params={sortParams} />
              <SortTh label={t('colProduct')} field="product" sort={params.sort} dir={params.dir} params={sortParams} />
              <SortTh label="📦" field="boxes" sort={params.sort} dir={params.dir} params={sortParams} className="p-2 text-right" />
              <SortTh label="kg/📦" field="perBoxKg" sort={params.sort} dir={params.dir} params={sortParams} className="p-2 text-right" />
              <SortTh label="Σ kg" field="stockKg" sort={params.sort} dir={params.dir} params={sortParams} className="p-2 text-right" />
              <SortTh label="m³" field="stockM3" sort={params.sort} dir={params.dir} params={sortParams} className="p-2 text-right" />
              <SortTh label="kg/m³" field="density" sort={params.sort} dir={params.dir} params={sortParams} className="p-2 text-right" />
              <SortTh label="📝" field="note" sort={params.sort} dir={params.dir} params={sortParams} />
              <SortTh label={t('colWh')} field="whCode" sort={params.sort} dir={params.dir} params={sortParams} />
              <SortTh label={t('colDate')} field="receivedAt" sort={params.sort} dir={params.dir} params={sortParams} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const { line, perBoxKg, stockKg, stockM3, density } = row;
              const densityClass =
                density === null
                  ? ''
                  : density >= 400
                    ? 'bg-bad/15 text-bad'
                    : density >= 300
                      ? 'bg-orange-100 text-orange-800'
                      : density >= 200
                        ? 'bg-good/15 text-good'
                        : 'bg-brand-100 text-brand-700';
              return (
                <tr key={line.lot.id} className="border-b border-line hover:bg-surface-sunken">
                  <td className="p-1.5">
                    <div className="flex items-center gap-1">
                      {line.photoId ? (
                        <LightboxImg
                          attachmentId={line.photoId}
                          className="h-14 w-14 rounded object-cover"
                        />
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                      {line.generalPhotoId && (
                        <LightboxImg
                          attachmentId={line.generalPhotoId}
                          testId="general-photo"
                          className="h-14 w-14 rounded border-2 border-warn/40 object-cover"
                        />
                      )}
                    </div>
                  </td>
                  <td className="whitespace-nowrap p-2">
                    <Link href={`/stock?lot=${line.lot.id}`} className="font-mono font-extrabold text-brand-700">
                      {line.clientCode ?? line.marking ?? '❓'}-{line.lot.letter}
                    </Link>
                  </td>
                  <td className="max-w-56 p-2">
                    <Link href={`/receipts/${line.receiptId}`} className="block truncate">
                      {line.lot.productNameZh}
                      {line.lot.productNameRu && (
                        <span className="text-ink-500"> ({line.lot.productNameRu})</span>
                      )}
                    </Link>
                  </td>
                  <td className="p-2 text-right font-semibold">{row.boxes}</td>
                  <td className="p-2 text-right">{Math.round(perBoxKg * 10) / 10}</td>
                  <td className="p-2 text-right font-semibold">{Math.round(stockKg)}</td>
                  <td className="p-2 text-right">{Math.round(stockM3 * 100) / 100}</td>
                  <td className="p-2 text-right">
                    {density !== null && (
                      <span className={`rounded px-1.5 py-0.5 font-semibold ${densityClass}`}>
                        {Math.round(density)}
                      </span>
                    )}
                  </td>
                  <td className="max-w-32 truncate p-2 text-xs text-ink-500" title={line.lot.note ?? ''}>
                    {line.lot.note ?? ''}
                  </td>
                  <td className="p-2 font-mono font-bold">{line.whCode}</td>
                  <td className="whitespace-nowrap p-2 text-ink-500">
                    {format.dateTime(line.receivedAt, { dateStyle: 'short' })}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {lines.length === 0 && <p className="p-4 text-sm text-ink-500">{t('empty')}</p>}
      </div>
    </div>
  );
}
