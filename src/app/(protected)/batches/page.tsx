import Link from 'next/link';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { batches, boxes, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { Panel } from '@/components/panel';
import { createQuickBatchAction } from './batch-actions-server';
import { PageHeader } from '@/components/ui/page';
import { warehouseScopeEither } from '@/modules/platform/rbac/scope';

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
  // The tile promises a permission the page never checked, so the board and
  // the archive were open by URL to everyone. `ved.docs` is in the list on
  // purpose: the customs papers live here and it is the VED manager's job.
  const canOpen = ['scan.load', 'scan.unload', 'ved.docs', 'plans.manage', 'batches.depart_close'];
  if (!canOpen.some((code) => actor.permissions.has(code))) redirect('/');
  const t = await getTranslations('batches');
  const params = await searchParams;
  const archiveOpen = params.archive === '1' || !!params.q;
  const canQuick = actor.permissions.has('batches.depart_close');
  const quickWhs = await db
    .select({
      id: warehouses.id,
      code: warehouses.code,
      allowsQuickBatch: warehouses.allowsQuickBatch,
    })
    .from(warehouses)
    .where(eq(warehouses.active, true))
    .orderBy(warehouses.code);
  // A warehouse worker loads from THEIR warehouse and nowhere else (owner:
  // "faqat o'zinikini belgilasin"). The action already refuses a foreign
  // origin, but offering it in the dropdown taught people to try — and the
  // refusal looked like a bug rather than a rule. The destination stays the
  // full list: sending cargo somewhere else is the whole point.
  // …and only from a warehouse that is allowed to start a truck with no plan
  // (owner, round 89: not from Kashgar). The DESTINATION list is untouched —
  // the flag is about who may skip the plan, not about where cargo may go.
  const originWhs = (
    actor.warehouseScoped
      ? quickWhs.filter((wh) => actor.warehouseIds.includes(wh.id))
      : quickWhs
  ).filter((wh) => wh.allowsQuickBatch);

  const dest = aliasedTable(warehouses, 'dest');
  const scope = warehouseScopeEither(actor, batches.originWarehouseId, batches.destWarehouseId);

  const listBatches = (statuses: readonly string[], limit: number, search?: string) =>
    db
      .select({
        batch: batches,
        originCode: warehouses.code,
        destCode: dest.code,
        // A finished batch has no member boxes left (unloading clears the
        // pointer), so the archive counts what actually departed with it.
        boxCount: sql<number>`(
          SELECT count(*) FROM ${boxes} b
          WHERE b.current_batch_id = ${batches.id} AND b.status <> 'void'
        ) + (
          SELECT count(*) FROM box_movements bm
          JOIN ${boxes} b3 ON b3.id = bm.box_id AND b3.status <> 'void'
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
      <PageHeader icon="truck" title={t('title')}
        actions={
          <Link href="/transit" className="btn-secondary px-3 text-sm">
          🔍 {t('transitReport')}
        </Link>
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
            defaultValue={quickWhs.find((wh) => wh.id !== originWhs[0]?.id)?.id}
          >
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
            <h2 className="text-sm font-bold uppercase tracking-wide text-ink-500">
              {t(`statuses.${status}`)}
            </h2>
            {rows
              .filter(({ batch }) => batch.status === status)
              .map(({ batch, originCode, destCode, boxCount }) => (
                <Link
                  key={batch.id}
                  href={`/batches/${batch.id}`}
                  className="card block !p-3 hover:bg-surface-sunken"
                >
                  <p className="font-mono font-extrabold text-brand-700">{batch.code}</p>
                  <p className="text-sm">
                    {originCode} → {destCode} · {boxCount} 📦
                  </p>
                  {batch.vehiclePlate && (
                    <p className="text-xs text-ink-500">🚛 {batch.vehiclePlate}</p>
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
          <p className="text-sm text-ink-500">{t('archiveEmpty')}</p>
        )}
        {archived.map(({ batch, originCode, destCode, boxCount }) => (
          <Link
            key={batch.id}
            href={`/batches/${batch.id}`}
            className="flex flex-wrap items-baseline gap-2 border-b border-line py-2 text-sm last:border-0 hover:bg-surface-sunken"
          >
            <span className="font-mono font-extrabold text-brand-700">{batch.code}</span>
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
