import Link from 'next/link';
import { asc, eq, sql } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  clients,
  receiptLots,
  receipts,
  scanEvents,
  warehouses,
} from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { batchCostSheet } from '@/modules/wms/costing/service';
import { costTypes, currencies } from '@/modules/platform/db/schema';
import { CostPanel } from '@/components/cost-panel';
import { VehicleForm } from './vehicle-form';
import { setSentToAgentAction } from '../batch-actions-server';
import { BatchActions } from './batch-actions';
import { UnloadActions } from './unload-actions';
import { BackLink } from '@/components/back-link';

export default async function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('batches');
  const format = await getFormatter();

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
  const { batch, originCode, destCode } = hit;

  const lots = await db
    .select({
      lotId: receiptLots.id,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
      planned: sql<number>`count(*) FILTER (WHERE ${boxes.status} = 'planned')`,
      loaded: sql<number>`count(*) FILTER (WHERE ${boxes.status} IN ('loading', 'in_transit'))`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(eq(boxes.currentBatchId, id))
    .groupBy(receiptLots.id, clients.clientCode, receipts.unclaimedMarking)
    .orderBy(asc(receiptLots.letter));

  const onSpotCount = (
    await db
      .select({ n: sql<number>`count(*)` })
      .from(scanEvents)
      .where(sql`${scanEvents.batchId} = ${id} AND ${scanEvents.addedOnSpot} = true`)
  )[0]!.n;

  const totalPlanned = lots.reduce((a, l) => a + Number(l.planned), 0);
  const totalLoaded = lots.reduce((a, l) => a + Number(l.loaded), 0);
  const canLoad = actor.permissions.has('scan.load') && ['forming', 'loading'].includes(batch.status);
  const canDepart = actor.permissions.has('batches.depart_close');
  const canVehicle = actor.permissions.has('batches.vehicle_info');
  const canUnload = actor.permissions.has('scan.unload');
  const canEnterCosts = actor.permissions.has('costs.enter_batch');
  const canSeeCosts = canEnterCosts || actor.permissions.has('reports.all_warehouses');

  const costSheet = canSeeCosts ? await batchCostSheet(id) : null;
  const costMeta = canSeeCosts
    ? {
        types: await db
          .select({ id: costTypes.id, code: costTypes.code, name: costTypes.name })
          .from(costTypes)
          .where(eq(costTypes.active, true)),
        currencies: (
          await db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true))
        ).map((c) => c.code),
        clients: await db
          .selectDistinct({ id: clients.id, clientCode: clients.clientCode })
          .from(boxes)
          .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
          .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
          .innerJoin(clients, eq(receipts.clientId, clients.id))
          .where(eq(boxes.currentBatchId, id)),
      }
    : null;

  const missingRows = await db
    .select({ box: boxes, letter: receiptLots.letter, clientCode: clients.clientCode, marking: receipts.unclaimedMarking })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(sql`${boxes.currentBatchId} = ${id} AND ${boxes.flags} @> '["missing_in_transit"]'::jsonb`);

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <BackLink href="/batches" label={t('title')} />
      <div className="card space-y-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="font-mono text-xl font-extrabold text-blue-800">{batch.code}</h1>
          <span className="font-mono font-bold">
            {originCode} → {destCode}
          </span>
          <span className="rounded bg-gray-100 px-2 py-0.5 text-sm font-semibold">
            {t(`statuses.${batch.status}`)}
          </span>
          <span className="ml-auto text-xs text-gray-500">
            {format.dateTime(batch.createdAt, { dateStyle: 'short' })}
          </span>
        </div>
        <p className="text-sm">
          <b>
            {totalLoaded}/{totalLoaded + totalPlanned} 📦
          </b>{' '}
          {t('loadedOfPlanned')}
          {Number(onSpotCount) > 0 && (
            <span className="ml-2 rounded bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-800">
              +{onSpotCount} {t('onSpot')}
            </span>
          )}
        </p>
        {batch.departedAt && (
          <p className="text-sm text-gray-600">
            🚀 {format.dateTime(batch.departedAt, { dateStyle: 'short', timeStyle: 'short' })}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {canLoad && (
            <Link
              href={`/batches/${batch.id}/load`}
              className="btn-primary flex-1 whitespace-nowrap px-3"
              data-testid="open-loading"
            >
              📱 {t('startLoading')}
            </Link>
          )}
          {canUnload && ['in_transit', 'arrived'].includes(batch.status) && (
            <Link
              href={`/batches/${batch.id}/unload`}
              className="btn-primary flex-1 whitespace-nowrap px-3"
              data-testid="open-unloading"
            >
              📤 {t('startUnloading')}
            </Link>
          )}
          <a
            href={`/api/batches/${batch.id}/manifest`}
            target="_blank"
            className="btn-secondary flex-1 whitespace-nowrap px-3"
          >
            ⬇️ {t('manifest')}
          </a>
        </div>
        {['forming', 'loading'].includes(batch.status) && (
          <BatchActions batchId={batch.id} canDepart={canDepart} />
        )}
        {(['in_transit', 'arrived', 'unloaded'].includes(batch.status) || missingRows.length > 0) && (
          <UnloadActions
            batchId={batch.id}
            status={batch.status}
            missing={missingRows.map(({ box, letter, clientCode, marking }) => ({
              boxId: box.id,
              shortCode: box.shortCode,
              label: `${clientCode ?? marking ?? '?'}-${letter}`,
            }))}
            canResolve={actor.permissions.has('receipts.void')}
            canClose={canDepart}
          />
        )}
      </div>

      {(actor.permissions.has('ved.docs') || actor.permissions.has('plans.manage')) && (
        <div className="card space-y-2">
          <h2 className="text-lg font-bold">📑 {t('vedDocs')}</h2>
          <div className="flex flex-wrap gap-2">
            <a href={`/api/batches/${batch.id}/invoice`} target="_blank" className="btn-secondary flex-1 whitespace-nowrap px-3">
              ⬇️ {t('invoice')}
            </a>
            <a href={`/api/batches/${batch.id}/packing`} target="_blank" className="btn-secondary flex-1 whitespace-nowrap px-3">
              ⬇️ {t('packingList')}
            </a>
          </div>
          {actor.permissions.has('ved.docs') && (
            <form action={setSentToAgentAction}>
              <input type="hidden" name="batchId" value={batch.id} />
              <button type="submit" className={`w-full rounded-lg border-2 border-dashed p-2.5 text-sm font-semibold ${batch.sentToAgentAt ? 'border-green-500 bg-green-50 text-green-800' : 'border-gray-300 text-gray-600'}`}>
                {batch.sentToAgentAt
                  ? `✅ ${t('sentToAgent')}: ${format.dateTime(new Date(batch.sentToAgentAt), { dateStyle: 'short' })}`
                  : `📤 ${t('markSentToAgent')}`}
              </button>
            </form>
          )}
        </div>
      )}

      {/* Editable until the batch is closed — a wrong plate/driver must be
          fixable even after departure (owner's request). */}
      {canVehicle && !['closed', 'cancelled'].includes(batch.status) ? (
        <VehicleForm
          batchId={batch.id}
          vehiclePlate={batch.vehiclePlate ?? ''}
          driverName={batch.driverName ?? ''}
          driverPhone={batch.driverPhone ?? ''}
        />
      ) : (
        (batch.vehiclePlate || batch.driverName) && (
          <div className="card text-sm">
            🚛 <span className="font-mono font-bold">{batch.vehiclePlate}</span>
            {batch.driverName && ` · ${batch.driverName}`}
            {batch.driverPhone && ` · ${batch.driverPhone}`}
          </div>
        )
      )}

      {costSheet && costMeta && (
        <div className="card space-y-2">
          <h2 className="text-lg font-bold">💰 {t('costs')}</h2>
          <CostPanel
            scope="batch"
            targetId={batch.id}
            entries={costSheet.entries.map(({ entry, typeName, clientCode }) => ({
              id: entry.id,
              typeName,
              amount: entry.amount,
              currency: entry.currency,
              amountUsd: entry.amountUsd,
              costDate: entry.costDate,
              allocationBasis: entry.allocationBasis,
              note: entry.note,
              clientCode,
            }))}
            costTypes={costMeta.types}
            currencies={costMeta.currencies}
            clientOptions={costMeta.clients}
            defaultCurrency={costMeta.currencies.includes('CNY') ? 'CNY' : 'USD'}
            canEdit={canEnterCosts}
          />
          {costSheet.entries.length > 0 && (
            <p className="border-t border-gray-100 pt-2 text-sm">
              <b>Σ ${costSheet.totalUsd}</b>
              {costSheet.usdPerKg !== null && (
                <span className="text-gray-600">
                  {' '}· ${costSheet.usdPerKg}/kg · ${costSheet.usdPerM3}/m³ ({costSheet.boxCount} 📦,{' '}
                  {costSheet.kg} kg, {costSheet.m3} m³)
                </span>
              )}
              {costSheet.unconverted > 0 && (
                <span className="ml-2 rounded bg-orange-100 px-1.5 text-xs font-semibold text-orange-800">
                  ⚠️ {costSheet.unconverted}
                </span>
              )}
            </p>
          )}
        </div>
      )}

      <div className="card space-y-1">
        <h2 className="text-lg font-bold">{t('contents')}</h2>
        {lots.map((lot) => (
          <div key={lot.lotId} className="flex items-baseline gap-2 border-b border-gray-100 py-1.5 text-sm last:border-0">
            <span className="font-mono font-extrabold text-blue-800">
              {lot.clientCode ?? lot.marking ?? '?'}-{lot.letter}
            </span>
            <span className="min-w-0 flex-1 truncate">{lot.productNameZh}</span>
            <span className="font-semibold">
              {lot.loaded}/{Number(lot.loaded) + Number(lot.planned)} 📦
            </span>
          </div>
        ))}
        {lots.length === 0 && <p className="text-sm text-gray-500">—</p>}
      </div>
    </div>
  );
}
