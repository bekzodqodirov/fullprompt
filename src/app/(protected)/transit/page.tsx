import Link from 'next/link';
import { desc, eq, sql } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm';
import { and } from 'drizzle-orm';
import { warehouseScopeEither } from '@/modules/platform/rbac/scope';
import { mayReadBatches } from '@/modules/wms/batches/read-door';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  clients,
  receiptLots,
  receipts,
  warehouses,
} from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader } from '@/components/ui/page';

/**
 * In-transit / missing-in-transit report (spec §13; KA hub view).
 *
 * Gated like the batches board it belongs to, and scoped like it: a signed-in
 * login was the whole door, so anybody with an account — a warehouse operator
 * in Yiwu, a seller, a driver-account holder — read every truck in the
 * company, every client code on every one of them, and the missing-cargo
 * list. The batches screen has asked for one of five permissions and fenced
 * on the truck's TWO ends since round 58; this page is the same data one
 * route over.
 */
export default async function TransitPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!mayReadBatches(actor.permissions)) redirect('/');
  // In transit belongs to no warehouse, so the fence is either END of the
  // trip — the rule `wms/search` states for exactly this table.
  const batchScope = warehouseScopeEither(
    actor,
    batches.originWarehouseId,
    batches.destWarehouseId,
  );
  const t = await getTranslations('transit');
  const tc = await getTranslations('common');
  const format = await getFormatter();

  const dest = aliasedTable(warehouses, 'dest');
  const inTransit = await db
    .select({
      batch: batches,
      originCode: warehouses.code,
      destCode: dest.code,
      boxCount: sql<number>`(SELECT count(*) FROM ${boxes} b WHERE b.current_batch_id = ${batches.id} AND b.status = 'in_transit')`,
    })
    .from(batches)
    .innerJoin(warehouses, eq(batches.originWarehouseId, warehouses.id))
    .innerJoin(dest, eq(batches.destWarehouseId, dest.id))
    .where(and(sql`${batches.status} IN ('in_transit', 'arrived')`, batchScope))
    .orderBy(desc(batches.departedAt));

  const missing = await db
    .select({
      box: boxes,
      letter: receiptLots.letter,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
      batchCode: batches.code,
      batchId: batches.id,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .innerJoin(batches, eq(boxes.currentBatchId, batches.id))
    // The missing list is the same cargo seen from the box side, so it takes
    // the same fence — a list that is scoped and a second list beside it that
    // is not is not a scoped screen.
    .where(and(sql`${boxes.flags} @> '["missing_in_transit"]'::jsonb`, batchScope));

  return (
    <div className="space-y-4">
      <PageHeader icon="truck" title={t('title')} />

      {missing.length > 0 && (
        <div className="space-y-2 rounded-xl border border-bad/30 bg-bad/10 p-3">
          <h2 className="font-bold text-bad">🔍 {t('missingTitle')} ({missing.length})</h2>
          {missing.map((row) => (
            <Link
              key={row.box.id}
              href={`/batches/${row.batchId}`}
              className="flex items-baseline gap-2 rounded-lg bg-surface-raised p-2 text-sm hover:bg-surface-sunken"
            >
              <span className="font-mono font-bold">{row.box.shortCode}</span>
              <span className="font-mono font-extrabold text-brand-700">
                {row.clientCode ?? row.marking ?? '?'}-{row.letter}
              </span>
              <span className="ml-auto font-mono text-xs text-ink-500">{row.batchCode}</span>
            </Link>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {inTransit.map(({ batch, originCode, destCode, boxCount }) => (
          <Link key={batch.id} href={`/batches/${batch.id}`} className="card block !p-3 hover:bg-surface-sunken">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono font-extrabold text-brand-700">{batch.code}</span>
              <span className="font-mono font-bold">
                {originCode} → {destCode}
              </span>
              <span className="font-semibold">{boxCount} 📦</span>
              {batch.vehiclePlate && <span className="text-xs text-ink-500">🚛 {batch.vehiclePlate}</span>}
              <span className="ml-auto text-xs text-ink-500">
                {batch.departedAt &&
                  `🚀 ${format.dateTime(batch.departedAt, { dateStyle: 'short', timeStyle: 'short' })}`}
              </span>
            </div>
          </Link>
        ))}
        {inTransit.length === 0 && <p className="text-ink-500">{tc('empty')}</p>}
      </div>
    </div>
  );
}
