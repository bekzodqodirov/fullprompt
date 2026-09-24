import { asc, eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { batches, costTypes, currencies, warehouses } from '@/modules/platform/db/schema';
import { aliasedTable } from 'drizzle-orm';
import { getActor } from '@/modules/platform/rbac/authorize';
import { inScope } from '@/modules/platform/rbac/scope';
import { batchScopeCostByType, receiptCostMatrix } from '@/modules/wms/costing/service';
import { batchLots } from '@/modules/wms/batches/lots';
import { canWriteDeal } from '@/modules/wms/deals/service';
import { listPartners } from '@/modules/wms/partners/service';
import { BackLink } from '@/components/back-link';
import { PageHeader } from '@/components/ui/page';
import { ReceiptCostGrid, type GridReceiptRow } from '../receipt-cost-grid';
import { maySeeStaffMoney } from '@/modules/wms/partners/staff';
import { tashkentDay } from '@/modules/platform/time/tashkent';

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

  // The goods, not only the prixod number (owner, 2026-09-24: «jadval rasxod
  // kiritadigan joyda tovar nomi, karobka soni va rasmi kerak»). The ROW
  // stays the prixod — a cost entry is receipt-scope, and the receipt card,
  // voidReceipt's money guard and the annul all key on it — the lots ride
  // inside it as lines.
  const gridRows = groupLotsByReceipt(await batchLots(id));
  const [matrix, batchScope] = await Promise.all([
    receiptCostMatrix(
      gridRows.map((row) => row.receiptId),
      id,
    ),
    batchScopeCostByType(id),
  ]);
  const existing = Object.fromEntries(matrix);
  const types = await db
    .select({ id: costTypes.id, name: costTypes.name })
    .from(costTypes)
    .where(eq(costTypes.active, true))
    // A column order the database happens to return is a column order that
    // can move between two sessions typing the same sheet (#524).
    .orderBy(asc(costTypes.createdAt), asc(costTypes.code));
  const currencyCodes = (
    await db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true))
  ).map((row) => row.code);
  // Same list the CostPanel offers: who settled this, when it was not us.
  const partnerOptions = canEnter
    ? (await listPartners({ includeStaff: maySeeStaffMoney(actor.permissions) })).map((row) => ({ id: row.id, name: row.name }))
    : [];

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
          rows={gridRows}
          types={types}
          existing={existing}
          batchScope={Object.fromEntries(batchScope)}
          dealLinks={canWriteDeal(actor.permissions)}
          currencies={currencyCodes}
          defaultCurrency="USD"
          today={tashkentDay()}
          canEdit={canEnter}
          partners={partnerOptions}
        />
      )}
    </div>
  );
}

/**
 * The truck's lots folded into one row per prixod, in the lots' own order
 * (client code, unclaimed last, then prixod number). The row's photo is its
 * first lot's goods, else the carton — this screen asks «what is it», which
 * is /stock's question and not the loader's.
 */
function groupLotsByReceipt(lots: Awaited<ReturnType<typeof batchLots>>): GridReceiptRow[] {
  const rows = new Map<string, GridReceiptRow>();
  for (const lot of lots) {
    let row = rows.get(lot.receiptId);
    if (!row) {
      row = {
        receiptId: lot.receiptId,
        number: lot.receiptNumber,
        clientCode: lot.clientCode,
        marking: lot.marking,
        dealId: lot.dealId,
        dealCode: lot.dealCode,
        photoId: null,
        boxes: 0,
        kg: 0,
        m3: 0,
        lots: [],
      };
      rows.set(lot.receiptId, row);
    }
    row.photoId ??= lot.goodsPhotoId ?? lot.boxPhotoId;
    row.boxes += lot.onBatch;
    row.kg = Math.round((row.kg + lot.kg) * 10) / 10;
    row.m3 = Math.round((row.m3 + lot.m3) * 1000) / 1000;
    row.lots.push({
      letter: lot.letter,
      name: lot.productNameRu ? `${lot.productNameZh} · ${lot.productNameRu}` : lot.productNameZh,
      onBatch: lot.onBatch,
      lotBoxCount: lot.lotBoxCount,
    });
  }
  return [...rows.values()];
}
