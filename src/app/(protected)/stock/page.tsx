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
  searchParams: Promise<{ wh?: string; client?: string; lot?: string }>;
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

  // Top level: per warehouse per client counts
  const grouped = await db
    .select({
      warehouseId: warehouses.id,
      whCode: warehouses.code,
      clientId: clients.id,
      clientCode: clients.clientCode,
      clientName: clients.name,
      boxCount: sql<number>`count(*)`,
      totalKg: sql<string>`sum(${receiptLots.totalWeightKg} / ${receiptLots.boxCount})`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .innerJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(and(...scopeFilter))
    .groupBy(warehouses.id, warehouses.code, clients.id, clients.clientCode, clients.name)
    .orderBy(asc(warehouses.code), asc(clients.clientCode));

  const byWarehouse = new Map<string, typeof grouped>();
  for (const row of grouped) {
    byWarehouse.set(row.whCode, [...(byWarehouse.get(row.whCode) ?? []), row]);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('title')}</h1>
      {[...byWarehouse.entries()].map(([whCode, rows]) => (
        <section key={whCode}>
          <h2 className="mb-2 font-mono text-lg font-extrabold text-blue-800">{whCode}</h2>
          <div className="space-y-1">
            {rows.map((row) => (
              <Link
                key={`${row.warehouseId}-${row.clientId ?? 'unclaimed'}`}
                href={row.clientId ? `/stock?client=${row.clientId}` : '/unclaimed'}
                className="card flex items-baseline gap-2 !p-3 hover:bg-gray-50"
              >
                <span
                  className={`font-mono font-extrabold ${row.clientCode ? 'text-blue-800' : 'text-orange-600'}`}
                >
                  {row.clientCode ?? '❓'}
                </span>
                <span className="truncate text-sm">{row.clientName ?? ''}</span>
                <span className="ml-auto whitespace-nowrap text-sm font-semibold">
                  {row.boxCount} {t('boxes')}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
