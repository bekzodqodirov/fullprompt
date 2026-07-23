import Link from 'next/link';
import { desc, eq, inArray, or, sql } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { batches, boxes, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';

const COLUMNS = ['forming', 'loading', 'in_transit', 'arrived'] as const;

/** Batch board (spec §10 screen): forming / loading / in transit / arrived. */
export default async function BatchesPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('batches');

  const dest = aliasedTable(warehouses, 'dest');
  const rows = await db
    .select({
      batch: batches,
      originCode: warehouses.code,
      destCode: dest.code,
      boxCount: sql<number>`(SELECT count(*) FROM ${boxes} b WHERE b.current_batch_id = ${batches.id})`,
    })
    .from(batches)
    .innerJoin(warehouses, eq(batches.originWarehouseId, warehouses.id))
    .innerJoin(dest, eq(batches.destWarehouseId, dest.id))
    .where(
      actor.warehouseScoped && actor.warehouseIds.length
        ? or(
            inArray(batches.originWarehouseId, actor.warehouseIds),
            inArray(batches.destWarehouseId, actor.warehouseIds),
          )
        : undefined,
    )
    .orderBy(desc(batches.createdAt))
    .limit(200);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">🚚 {t('title')}</h1>
        <Link href="/transit" className="btn-secondary px-3 text-sm">
          🔍 {t('transitReport')}
        </Link>
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        {COLUMNS.map((status) => (
          <div key={status} className="space-y-2">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">
              {t(`statuses.${status}`)}
            </h2>
            {rows
              .filter(({ batch }) => batch.status === status)
              .map(({ batch, originCode, destCode, boxCount }) => (
                <Link
                  key={batch.id}
                  href={`/batches/${batch.id}`}
                  className="card block !p-3 hover:bg-gray-50"
                >
                  <p className="font-mono font-extrabold text-blue-800">{batch.code}</p>
                  <p className="text-sm">
                    {originCode} → {destCode} · {boxCount} 📦
                  </p>
                  {batch.vehiclePlate && (
                    <p className="text-xs text-gray-500">🚛 {batch.vehiclePlate}</p>
                  )}
                </Link>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
