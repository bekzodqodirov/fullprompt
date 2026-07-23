import Link from 'next/link';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  boxes,
  clients,
  receiptLots,
  receipts,
  warehouses,
} from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';

/** Stock browser v1 (spec §10 screen 6): WH → client → lot → box. */
export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{ wh?: string; client?: string; lot?: string; q?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('stock');
  const params = await searchParams;

  const scopeFilter: SQL[] = [eq(boxes.status, 'in_stock')];
  if (actor.warehouseScoped && actor.warehouseIds.length) {
    scopeFilter.push(inArray(boxes.currentWarehouseId, actor.warehouseIds));
  }
  if (params.wh) scopeFilter.push(eq(boxes.currentWarehouseId, params.wh));

  // Lot drill-down: box list
  if (params.lot) {
    const boxRows = await db
      .select()
      .from(boxes)
      .where(eq(boxes.lotId, params.lot))
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
              className="card flex items-baseline gap-2 !p-3 hover:bg-gray-50"
            >
              <span className="font-mono font-bold">{box.shortCode}</span>
              <span className="text-sm text-gray-500">
                {box.seqInLot}/{lot?.boxCount}
              </span>
              <span className="ml-auto rounded bg-gray-100 px-2 py-0.5 text-xs font-semibold">
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
          <span className="font-mono text-blue-800">{client?.clientCode}</span> — {client?.name}
        </h1>
        <div className="space-y-1">
          {lotRows.map(({ lot, receiptNumber, whCode, inStock }) => (
            <Link
              key={lot.id}
              href={`/stock?lot=${lot.id}`}
              className="card block !p-3 hover:bg-gray-50"
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-lg font-extrabold text-blue-800">{lot.letter}</span>
                <span>
                  {lot.productNameZh} {lot.productNameRu && `(${lot.productNameRu})`}
                </span>
                <span className="ml-auto text-sm font-semibold">
                  {inStock} {t('boxes')}
                </span>
              </div>
              <p className="text-xs text-gray-500">
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

  const sumBoxes = lines.reduce((acc, l) => acc + Number(l.inStock), 0);
  const sumKg = lines.reduce(
    (acc, l) => acc + (Number(l.lot.totalWeightKg) / l.lot.boxCount) * Number(l.inStock),
    0,
  );
  const sumM3 = lines.reduce(
    (acc, l) => acc + (Number(l.lot.totalVolumeM3) / l.lot.boxCount) * Number(l.inStock),
    0,
  );

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
      </form>

      <p className="text-sm font-semibold text-gray-700">
        Σ {sumBoxes} {t('boxes')} · {Math.round(sumKg)} kg · {Math.round(sumM3 * 100) / 100} m³
      </p>

      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-gray-300 bg-gray-50 text-left">
              <th className="p-2">📷</th>
              <th className="p-2">{t('colCode')}</th>
              <th className="p-2">{t('colProduct')}</th>
              <th className="p-2 text-right">📦</th>
              <th className="p-2 text-right">kg/📦</th>
              <th className="p-2 text-right">Σ kg</th>
              <th className="p-2 text-right">m³</th>
              <th className="p-2 text-right">kg/m³</th>
              <th className="p-2">📝</th>
              <th className="p-2">{t('colWh')}</th>
              <th className="p-2">{t('colDate')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const perBoxKg = Number(line.lot.totalWeightKg) / line.lot.boxCount;
              const stockKg = perBoxKg * Number(line.inStock);
              const stockM3 =
                (Number(line.lot.totalVolumeM3) / line.lot.boxCount) * Number(line.inStock);
              const density =
                Number(line.lot.totalVolumeM3) > 0
                  ? Number(line.lot.totalWeightKg) / Number(line.lot.totalVolumeM3)
                  : null;
              const densityClass =
                density === null
                  ? ''
                  : density >= 400
                    ? 'bg-red-100 text-red-800'
                    : density >= 300
                      ? 'bg-orange-100 text-orange-800'
                      : density >= 200
                        ? 'bg-green-100 text-green-800'
                        : 'bg-blue-100 text-blue-800';
              return (
                <tr key={line.lot.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="p-1.5">
                    {line.photoId ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/attachments/${line.photoId}?variant=thumb200`}
                        alt=""
                        className="h-12 w-12 rounded object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap p-2">
                    <Link href={`/stock?lot=${line.lot.id}`} className="font-mono font-extrabold text-blue-800">
                      {line.clientCode ?? line.marking ?? '❓'}-{line.lot.letter}
                    </Link>
                  </td>
                  <td className="max-w-56 p-2">
                    <Link href={`/receipts/${line.receiptId}`} className="block truncate">
                      {line.lot.productNameZh}
                      {line.lot.productNameRu && (
                        <span className="text-gray-500"> ({line.lot.productNameRu})</span>
                      )}
                    </Link>
                  </td>
                  <td className="p-2 text-right font-semibold">{line.inStock}</td>
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
                  <td className="max-w-32 truncate p-2 text-xs text-gray-500" title={line.lot.note ?? ''}>
                    {line.lot.note ?? ''}
                  </td>
                  <td className="p-2 font-mono font-bold">{line.whCode}</td>
                  <td className="whitespace-nowrap p-2 text-gray-500">
                    {new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short' }).format(line.receivedAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
