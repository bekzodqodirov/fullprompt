import { eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { batches, costTypes, currencies, warehouses } from '@/modules/platform/db/schema';
import { aliasedTable } from 'drizzle-orm';
import { getActor } from '@/modules/platform/rbac/authorize';
import { inScope } from '@/modules/platform/rbac/scope';
import { batchReceiptRows, receiptCostMatrix } from '@/modules/wms/costing/service';
import { BackLink } from '@/components/back-link';
import { PageHeader } from '@/components/ui/page';
import { ReceiptCostGrid } from '../receipt-cost-grid';

/**
 * «Расходы по приходам» on a screen of its own (round 47, owner's item 8:
 * «kichkina joyga katta narsa tiqilgan — butun ekranga sig'adigan qilib»).
 *
 * The grid is a spreadsheet: one row per prixod, one column per expense type,
 * and a truck with twelve receipts and six cost types is 72 input boxes. Under
 * the batch card it lived inside the main column of a two-column layout, so it
 * had roughly half a laptop screen and a phone's width to draw all of that in,
 * and every cell was a sliver. Here it owns the viewport — nothing else is on
 * the page — and the batch card links to it instead.
 *
 * Same permission as entering a batch cost, because that is exactly what a
 * saved cell becomes; the cargo-scope check is the batch card's own rule.
 */
export default async function BatchCostGridPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  const canEnter = actor.permissions.has('costs.enter_batch');
  if (!canEnter && !actor.permissions.has('reports.all_warehouses')) redirect('/');
  const t = await getTranslations('batches');
  const tc = await getTranslations('common');

  const dest = aliasedTable(warehouses, 'dest');
  const rows = await db
    .select({ batch: batches, originCode: warehouses.code, destCode: dest.code })
    .from(batches)
    .innerJoin(warehouses, eq(batches.originWarehouseId, warehouses.id))
    .innerJoin(dest, eq(batches.destWarehouseId, dest.id))
    .where(eq(batches.id, id))
    .limit(1);
  const hit = rows[0];
  if (!hit) notFound();
  if (!inScope(actor, hit.batch.originWarehouseId) && !inScope(actor, hit.batch.destWarehouseId)) {
    notFound();
  }

  const gridRows = await batchReceiptRows(id);
  const existing = Object.fromEntries(await receiptCostMatrix(gridRows.map((row) => row.receiptId)));
  const types = await db
    .select({ id: costTypes.id, name: costTypes.name })
    .from(costTypes)
    .where(eq(costTypes.active, true));
  const currencyCodes = (
    await db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true))
  ).map((row) => row.code);

  return (
    <div className="space-y-3">
      <BackLink href={`/batches/${id}`} label={hit.batch.code} />
      <PageHeader icon="wallet" title={t('receiptGridTitle')} />
      <p className="text-sm text-ink-500">{t('receiptGridHint')}</p>
      {gridRows.length === 0 ? (
        <p className="card text-sm text-ink-500">{tc('empty')}</p>
      ) : (
        <ReceiptCostGrid
          batchId={id}
          rows={gridRows.map((row) => ({
            receiptId: row.receiptId,
            number: row.number,
            clientCode: row.clientCode,
            kg: row.kg,
            m3: row.m3,
          }))}
          types={types}
          existing={existing}
          currencies={currencyCodes}
          defaultCurrency="USD"
          today={new Date().toISOString().slice(0, 10)}
          canEdit={canEnter}
        />
      )}
    </div>
  );
}
