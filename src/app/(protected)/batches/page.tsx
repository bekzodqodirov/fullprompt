import Link from 'next/link';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { batches, boxes, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { Panel } from '@/components/panel';
import { createQuickBatchAction } from './batch-actions-server';

const COLUMNS = ['forming', 'loading', 'in_transit', 'arrived'] as const;
/** Finished work: off the board, but the owner still needs to find it. */
const ARCHIVED = ['unloaded', 'closed', 'cancelled'] as const;

/**
 * Batch board (spec §10 screen): forming / loading / in transit / arrived,
 * plus an archive drawer — a batch used to vanish completely once it was
 * unloaded, with no way back to its manifest or costs (owner's report).
 */
export default async function BatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ archive?: string; q?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('batches');
  const params = await searchParams;
  const archiveOpen = params.archive === '1' || !!params.q;
  const canQuick = actor.permissions.has('batches.depart_close');
  const quickWhs = await db
    .select({ id: warehouses.id, code: warehouses.code })
    .from(warehouses)
    .orderBy(warehouses.code);

  const dest = aliasedTable(warehouses, 'dest');
  const scope =
    actor.warehouseScoped && actor.warehouseIds.length
      ? or(
          inArray(batches.originWarehouseId, actor.warehouseIds),
          inArray(batches.destWarehouseId, actor.warehouseIds),
        )
      : undefined;

  const listBatches = (statuses: readonly string[], limit: number, search?: string) =>
    db
      .select({
        batch: batches,
        originCode: warehouses.code,
        destCode: dest.code,
        // A finished batch has no member boxes left (unloading clears the
        // pointer), so the archive counts what actually departed with it.
        boxCount: sql<number>`(
          SELECT count(*) FROM ${boxes} b WHERE b.current_batch_id = ${batches.id}
        ) + (
          SELECT count(*) FROM box_movements bm
          WHERE bm.ref_type = 'batch' AND bm.ref_id = ${batches.id}
            AND bm.cause = 'batch_departed'
            AND NOT EXISTS (
              SELECT 1 FROM ${boxes} b2
              WHERE b2.id = bm.box_id AND b2.current_batch_id = ${batches.id}
            )
        )`,
      })
      .from(batches)
      .innerJoin(warehouses, eq(batches.originWarehouseId, warehouses.id))
      .innerJoin(dest, eq(batches.destWarehouseId, dest.id))
      .where(
        and(
          scope,
          inArray(batches.status, [...statuses]),
          search
            ? sql`(${batches.code} ILIKE ${'%' + search + '%'} OR ${batches.vehiclePlate} ILIKE ${'%' + search + '%'} OR ${batches.driverName} ILIKE ${'%' + search + '%'})`
            : undefined,
        ),
      )
      .orderBy(desc(batches.createdAt))
      .limit(limit);

  const rows = await listBatches(COLUMNS, 200);
  const archived = archiveOpen ? await listBatches(ARCHIVED, 100, params.q?.trim() || undefined) : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">🚚 {t('title')}</h1>
        <Link href="/transit" className="btn-secondary px-3 text-sm">
          🔍 {t('transitReport')}
        </Link>
      </div>

      {canQuick && (
        <form action={createQuickBatchAction} className="card flex flex-wrap items-center gap-2 !p-3">
          <span className="text-sm font-bold">⚡ {t('quickBatch')}</span>
          <select name="originId" aria-label={t('quickOrigin')} className="input !w-24 font-mono font-bold" defaultValue={quickWhs[0]?.id}>
            {quickWhs.map((wh) => (
              <option key={wh.id} value={wh.id}>
                {wh.code}
              </option>
            ))}
          </select>
          <span className="font-bold">→</span>
          <select name="destId" aria-label={t('quickDest')} className="input !w-24 font-mono font-bold" defaultValue={quickWhs[1]?.id}>
            {quickWhs.map((wh) => (
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

      <Panel title={`🗄 ${t('archive')}`} open={archiveOpen}>
        <form method="get" className="flex gap-2">
          <input type="hidden" name="archive" value="1" />
          <input
            type="search"
            name="q"
            defaultValue={params.q ?? ''}
            placeholder={t('archiveSearch')}
            className="input flex-1"
          />
          <button type="submit" className="btn-primary px-4">
            🔍
          </button>
        </form>
        {archiveOpen && archived.length === 0 && (
          <p className="text-sm text-gray-500">{t('archiveEmpty')}</p>
        )}
        {archived.map(({ batch, originCode, destCode, boxCount }) => (
          <Link
            key={batch.id}
            href={`/batches/${batch.id}`}
            className="flex flex-wrap items-baseline gap-2 border-b border-gray-100 py-2 text-sm last:border-0 hover:bg-gray-50"
          >
            <span className="font-mono font-extrabold text-blue-800">{batch.code}</span>
            <span className="font-mono">
              {originCode} → {destCode}
            </span>
            <span>{boxCount} 📦</span>
            {batch.vehiclePlate && <span className="text-gray-500">🚛 {batch.vehiclePlate}</span>}
            <span className="ml-auto text-xs text-gray-500">
              {t(`statuses.${batch.status}`)}
              {batch.closedAt ? ` · ${batch.closedAt.toISOString().slice(0, 10)}` : ''}
            </span>
          </Link>
        ))}
      </Panel>
    </div>
  );
}
