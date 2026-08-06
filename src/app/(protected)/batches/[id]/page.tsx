import Link from 'next/link';
import { and, asc, eq, sql } from 'drizzle-orm';
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
import { batchCostSheet, batchReceiptRows } from '@/modules/wms/costing/service';
import { attachments, costTypes, currencies } from '@/modules/platform/db/schema';
import { CostPanel } from '@/components/cost-panel';
import { VehicleForm } from './vehicle-form';
import {
  createDriverDeviceAction,
  revokeDriverDeviceAction,
  setSentToAgentAction,
  setTrackingCheckpointAction,
} from '../batch-actions-server';
import { devicesForBatch } from '@/modules/wms/tracking/devices';
import { batchMemberFilter, remainingToUnload } from '@/modules/wms/scanning/unload';
import { LightboxImg } from '@/components/lightbox-img';
import { Panel } from '@/components/panel';
import { BatchCodeForm } from './batch-code-form';
import { BatchActions } from './batch-actions';
import { UnloadActions } from './unload-actions';
import { BackLink } from '@/components/back-link';
import { CardCols } from '@/components/card-cols';
import { CustomFieldsPanel } from '@/components/custom-fields-panel';
import { TasksPanel } from '@/components/tasks-panel';
import { inScope } from '@/modules/platform/rbac/scope';
import { listPartners } from '@/modules/wms/partners/service';
import { AttachmentsPanel } from '@/components/attachments-panel';
import { CustomsFirm } from './customs-firm';
import { CustomsPerReceipt } from './customs-per-receipt';
import { batchCustomsRows } from '@/modules/wms/partners/customs';

/**
 * The status chip wears the stage's colour so the card answers "where is
 * this trip" before a word is read. A lookup of full literal classes —
 * Tailwind cannot see a class built at runtime.
 */
const STATUS_CLASS: Record<string, string> = {
  forming: 'bg-surface-sunken text-ink-700',
  loading: 'bg-warn/10 text-warn',
  in_transit: 'bg-brand-50 text-brand-700',
  arrived: 'bg-good/10 text-good',
  unloaded: 'bg-good/10 text-good',
  closed: 'bg-surface-sunken text-ink-500',
  cancelled: 'bg-bad/10 text-bad',
};

export default async function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('batches');
  const tc = await getTranslations('common');
  // The contents table is the stock table applied to a truck, so it borrows
  // the stock screen's own column names rather than inventing second ones.
  const tstock = await getTranslations('stock');
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
  // Origin OR destination — exactly the rule the batch LIST already uses. A
  // trip belongs to both warehouses; only the list was saying so.
  if (!inScope(actor, hit.batch.originWarehouseId) && !inScope(actor, hit.batch.destWarehouseId)) {
    notFound();
  }
  const { batch, originCode, destCode } = hit;

  // The truck's contents, read the way the stock screen reads a shelf (owner:
  // «uni ichidagisni sklad qoldiqlaridek toliq neccha kub necha kg rasimlari
  // bn»). Two things had to change for that to be true after departure:
  // membership is `batchMemberFilter`, not the live pointer — an unloaded box
  // no longer points at its truck and the old count read 0/0 for a whole
  // arrived batch — and kg/m³ come off the lot, shared per box, so a truck
  // carrying half a lot is credited with half its weight.
  const lots = await db
    .select({
      lotId: receiptLots.id,
      receiptId: receipts.id,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      productNameRu: receiptLots.productNameRu,
      lotBoxCount: receiptLots.boxCount,
      lotWeightKg: receiptLots.totalWeightKg,
      lotVolumeM3: receiptLots.totalVolumeM3,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
      onBatch: sql<number>`count(*)`,
      planned: sql<number>`count(*) FILTER (WHERE ${boxes.status} = 'planned')`,
      loaded: sql<number>`count(*) FILTER (WHERE ${boxes.status} IN ('loading', 'in_transit'))`,
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
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(batchMemberFilter(id))
    .groupBy(receiptLots.id, receipts.id, clients.clientCode)
    .orderBy(asc(receiptLots.letter));

  // Per-lot kg/m³ are a share of the lot, so the totals have to be derived
  // before they can be summed — same shape as the stock table.
  const contents = lots.map((lot) => {
    const onBatch = Number(lot.onBatch);
    const per = lot.lotBoxCount > 0 ? onBatch / lot.lotBoxCount : 0;
    return {
      ...lot,
      onBatch,
      kg: Number(lot.lotWeightKg) * per,
      m3: Number(lot.lotVolumeM3) * per,
    };
  });
  const totalKg = contents.reduce((acc, row) => acc + row.kg, 0);
  const totalM3 = contents.reduce((acc, row) => acc + row.m3, 0);
  const totalBoxes = contents.reduce((acc, row) => acc + row.onBatch, 0);

  const onSpotCount = (
    await db
      .select({ n: sql<number>`count(*)` })
      .from(scanEvents)
      .where(sql`${scanEvents.batchId} = ${id} AND ${scanEvents.addedOnSpot} = true`)
  )[0]!.n;

  const totalPlanned = lots.reduce((a, l) => a + Number(l.planned), 0);
  const totalLoaded = lots.reduce((a, l) => a + Number(l.loaded), 0);
  const canLoad = actor.permissions.has('scan.load') && ['forming', 'loading'].includes(batch.status);
  const canDepartClose = actor.permissions.has('batches.depart_close');
  // Owner's rule: the origin-warehouse loader can also send the truck off
  // (with a confirm dialog); closing/arrival stays manager-only.
  const inOriginScope = !actor.warehouseScoped || actor.warehouseIds.includes(batch.originWarehouseId);
  const canDepart = canDepartClose || (actor.permissions.has('scan.load') && inOriginScope);
  const canVehicle = actor.permissions.has('batches.vehicle_info');
  const canUnload = actor.permissions.has('scan.unload');
  const canEnterCosts = actor.permissions.has('costs.enter_batch');
  const canSeeCosts = canEnterCosts || actor.permissions.has('reports.all_warehouses');

  const devices = canVehicle ? await devicesForBatch(id) : [];
  // Every batch is minted with a driver code, so the header can carry it
  // (owner) instead of making the loader scroll to a panel and press a button
  // while the driver waits with the phone in their hand. It disappears the
  // moment a phone claims it — a burnt code on a header teaches nothing.
  const pairCode = devices.find((device) => device.pairCode)?.pairCode ?? null;
  const costSheet = canSeeCosts ? await batchCostSheet(id) : null;
  // Round 39: a truck's freight and its customs bill are usually settled by
  // somebody else's account, so the cost form has to be able to say whose.
  // The papers that ride with the truck (owner: «1 ta partiyaga yo'lda
  // bo'ladigan dokumentlarni qo'shib ketadigan joy»).
  // Only the customs firms, plus whichever partner is already on this truck
  // — a firm retired last month must not vanish from the record it is on.
  // Retired firms included on purpose: the `|| row.id === batch.customsPartnerId`
  // escape below was dead code while this read active-only, so a firm retired
  // after it cleared this truck dropped out of the picker — and a select whose
  // value matches no option silently shows the FIRST one, which here reads
  // «as the truck says». New rows are offered the live firms only.
  const allPartners = await listPartners({ includeInactive: true });
  const partnerOptions = canEnterCosts
    ? allPartners.filter((r) => r.active).map((r) => ({ id: r.id, name: r.name }))
    : [];
  const customsRows = await batchCustomsRows(id);
  const customsChosen = new Set(
    [batch.customsPartnerId, ...customsRows.map((row) => row.partnerId)].filter(
      (value): value is string => value !== null,
    ),
  );
  const customsPartners = allPartners
    .filter((row) => (row.typeCode === 'customs' && row.active) || customsChosen.has(row.id))
    .map((row) => ({ id: row.id, name: row.name }));
  // What the collapsed panel says out loud: which firm clears this truck, and
  // how many prixods answer for themselves. Without it the panel is one more
  // shut door among seven and nobody opens it (round 43).
  const customsOwnAnswers = customsRows.filter((row) => !row.fromBatch).length;
  const customsBadge = [
    batch.customsByClient
      ? t('customsByClient')
      : (customsPartners.find((row) => row.id === batch.customsPartnerId)?.name ?? '—'),
    customsOwnAnswers > 0 ? `+${customsOwnAnswers}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const batchFiles = await db
    .select({
      id: attachments.id,
      fileName: attachments.fileName,
      contentType: attachments.contentType,
      kind: attachments.kind,
    })
    .from(attachments)
    .where(and(eq(attachments.entityType, 'batch'), eq(attachments.entityId, id)));
  // Round 29's grid lives on its own screen since round 47; the card only
  // needs to know how big it is, to decide whether to offer the door at all.
  const gridRows = canSeeCosts ? await batchReceiptRows(id) : [];
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

  // Still on the truck as far as the system knows. Shown next to the unload
  // actions so nobody finishes an unload without seeing what it will declare
  // missing (owner's report).
  const remainingToAccept = ['in_transit', 'arrived'].includes(batch.status)
    ? (await remainingToUnload(id)).length
    : 0;

  // What was actually loaded, box by box — from load scan events, so the
  // list survives unload/close (owner: after the truck leaves, the sending
  // warehouse only needs to SEE what it loaded — read-only).
  const loadedBoxes = ['forming'].includes(batch.status)
    ? []
    : await db
        .selectDistinct({
          shortCode: boxes.shortCode,
          letter: receiptLots.letter,
          clientCode: clients.clientCode,
          marking: receipts.unclaimedMarking,
        })
        .from(scanEvents)
        .innerJoin(boxes, eq(scanEvents.boxId, boxes.id))
        .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
        .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
        .leftJoin(clients, eq(receipts.clientId, clients.id))
        .where(sql`${scanEvents.batchId} = ${id} AND ${scanEvents.type} = 'load'`)
        .orderBy(asc(receiptLots.letter), asc(boxes.shortCode));

  return (
    // Full width like the other redesigned cards: the header block (code,
    // status, THE stage action) stays above the grid — CardCols renders its
    // rail first on a phone, and the loading button must never sit under six
    // folded panels.
    <div className="space-y-4">
      <BackLink href="/batches" label={t('title')} />
      <div className="card space-y-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <BatchCodeForm
            batchId={batch.id}
            code={batch.code}
            editable={
              actor.permissions.has('plans.manage') &&
              ['forming', 'loading'].includes(batch.status)
            }
          />
          <span className="font-mono font-bold">
            {originCode} → {destCode}
          </span>
          <span
            className={`rounded px-2 py-0.5 text-sm font-semibold ${
              STATUS_CLASS[batch.status] ?? 'bg-surface-sunken text-ink-700'
            }`}
          >
            {t(`statuses.${batch.status}`)}
          </span>
          <span className="ml-auto text-xs text-ink-500">
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
          <p className="text-sm text-ink-700">
            🚀 {format.dateTime(batch.departedAt, { dateStyle: 'short', timeStyle: 'short' })}
          </p>
        )}
        {pairCode && !['closed', 'cancelled'].includes(batch.status) && (
          <p className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm text-ink-500">📲 {t('pairCodeLabel')}</span>
            <span
              data-testid="batch-pair-code"
              className="font-mono text-2xl font-extrabold tracking-widest text-brand-700"
            >
              {pairCode}
            </span>
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
          {/* The manifest XLSX is gone (owner): the VED papers and the photo
              packing list are what actually travel with the truck. The route
              /api/batches/[id]/manifest still exists if it is ever wanted. */}
        </div>
        {['forming', 'loading'].includes(batch.status) && (
          <BatchActions
            batchId={batch.id}
            canDepart={canDepart}
            // Giving the cargo back and retiring the trip is a manager's call,
            // not the loader's — unlike departure, which the person standing
            // at the truck may do.
            canCancel={actor.permissions.has('batches.depart_close')}
          />
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
            remaining={remainingToAccept}
            canUnload={canUnload}
            canResolve={actor.permissions.has('receipts.void')}
            canClose={canDepartClose}
          />
        )}
      </div>

      <CardCols
        main={
          <>
      <div className="card space-y-2">
        <h2 className="text-lg font-bold">{t('contents')}</h2>
        <p className="text-sm font-semibold text-ink-700" data-testid="batch-contents-total">
          Σ {totalBoxes} 📦 · {Math.round(totalKg)} kg · {Math.round(totalM3 * 100) / 100} m³
        </p>
        {contents.length === 0 && <p className="text-sm text-ink-500">{tc('empty')}</p>}
        {/* Its own sideways scroll: a row wider than the phone rescales the
            WHOLE page, and then every tap lands somewhere else (#400). An empty
            truck gets the sentence alone — a header row over nothing reads as
            a broken table. */}
        {contents.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-line-strong bg-surface-sunken text-left">
                <th className="p-2">📷</th>
                <th className="p-2">{tstock('colCode')}</th>
                <th className="p-2">{tstock('colProduct')}</th>
                <th className="p-2 text-right">📦</th>
                <th className="p-2 text-right">kg</th>
                <th className="p-2 text-right">m³</th>
              </tr>
            </thead>
            <tbody>
              {contents.map((lot) => (
                <tr key={lot.lotId} className="border-b border-line last:border-0">
                  <td className="p-1.5">
                    <div className="flex items-center gap-1">
                      {lot.photoId ? (
                        <LightboxImg
                          attachmentId={lot.photoId}
                          className="h-20 w-20 rounded-lg object-cover"
                        />
                      ) : lot.generalPhotoId ? (
                        <LightboxImg
                          attachmentId={lot.generalPhotoId}
                          className="h-20 w-20 rounded-lg border-2 border-warn/40 object-cover"
                        />
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </div>
                  </td>
                  <td className="whitespace-nowrap p-2">
                    <Link
                      href={`/stock?lot=${lot.lotId}`}
                      className="font-mono font-extrabold text-brand-700"
                    >
                      {lot.clientCode ?? lot.marking ?? '?'}-{lot.letter}
                    </Link>
                  </td>
                  <td className="max-w-56 p-2">
                    <Link href={`/receipts/${lot.receiptId}`} className="block truncate">
                      {lot.productNameZh}
                      {lot.productNameRu && (
                        <span className="text-ink-500"> ({lot.productNameRu})</span>
                      )}
                    </Link>
                  </td>
                  <td className="p-2 text-right font-semibold">
                    {/* While the truck is being filled the useful number is
                        progress; once it has left, the plan is history and the
                        count IS the cargo. */}
                    {Number(lot.planned) > 0 ? `${lot.loaded}/${lot.onBatch}` : lot.onBatch}
                  </td>
                  <td className="p-2 text-right">{Math.round(lot.kg)}</td>
                  <td className="p-2 text-right">{Math.round(lot.m3 * 100) / 100}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </div>

      {loadedBoxes.length > 0 && (
        <details className="card">
          <summary className="cursor-pointer text-lg font-bold">
            🧾 {t('loadedBoxes')} ({loadedBoxes.length})
          </summary>
          <div className="mt-2 space-y-1 text-sm">
            {[...loadedBoxes
              .reduce((acc, b) => {
                const label = `${b.clientCode ?? b.marking ?? '?'}-${b.letter}`;
                acc.set(label, [...(acc.get(label) ?? []), b.shortCode]);
                return acc;
              }, new Map<string, string[]>())
              .entries()].map(([label, codes]) => (
              <p key={label} className="border-b border-line py-1 last:border-0">
                <span className="font-mono font-extrabold text-brand-700">{label}</span>{' '}
                <span className="font-mono text-xs text-ink-700">{codes.join(', ')}</span>
              </p>
            ))}
          </div>
        </details>
      )}

      {costSheet && costMeta && (
        <div className="card space-y-2">
          <h2 className="text-lg font-bold">💰 {t('costs')}</h2>
          <CostPanel
            scope="batch"
            targetId={batch.id}
            entries={costSheet.entries.map(({ entry, typeName, clientCode, partnerName }) => ({
              id: entry.id,
              typeName,
              amount: entry.amount,
              currency: entry.currency,
              amountUsd: entry.amountUsd,
              costDate: entry.costDate,
              allocationBasis: entry.allocationBasis,
              note: entry.note,
              clientCode,
              partnerName,
            }))}
            costTypes={costMeta.types}
            currencies={costMeta.currencies}
            clientOptions={costMeta.clients}
            defaultCurrency={costMeta.currencies.includes('CNY') ? 'CNY' : 'USD'}
            canEdit={canEnterCosts}
            partnerOptions={partnerOptions}
          />
          {costSheet.entries.length > 0 && (
            <p className="border-t border-line pt-2 text-sm">
              <b>Σ ${costSheet.totalUsd}</b>
              {costSheet.usdPerKg !== null && (
                <span className="text-ink-700">
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

      {/* Round 29's grid moved OUT of the card in round 47 (owner: «kichkina
          joyga katta narsa tiqilgan»). Twelve prixods across six cost types
          is 72 boxes, and half of a two-column card is not a spreadsheet.
          What stays here is the door, with the count that says whether it is
          worth opening. */}
      {canSeeCosts && gridRows.length > 0 && (
        <Link
          href={`/batches/${batch.id}/xarajatlar`}
          data-testid="batch-cost-grid-link"
          className="card-tap flex items-center gap-3"
        >
          <span className="text-xl">🧾</span>
          <span className="min-w-0 flex-1">
            <span className="block font-bold">{t('receiptGridTitle')}</span>
            <span className="block text-xs text-ink-500">
              {gridRows.length} × {costMeta?.types.length ?? 0}
            </span>
          </span>
          <span className="text-ink-400">›</span>
        </Link>
      )}
          </>
        }
        rail={
          <>
      {(actor.permissions.has('ved.docs') || actor.permissions.has('plans.manage')) && (
        <Panel title={`📑 ${t('vedDocs')}`}>
          <div className="flex flex-wrap gap-2">
            <a href={`/api/batches/${batch.id}/invoice`} target="_blank" className="btn-secondary flex-1 whitespace-nowrap px-3">
              ⬇️ {t('invoice')}
            </a>
            {/* The draft packing list is gone: the photo packing list replaced
                it in practice (owner). The generator stays reachable at
                /api/batches/[id]/packing if it is ever needed again. */}
            {(totalLoaded > 0 || loadedBoxes.length > 0) && (
              <a href={`/api/batches/${batch.id}/packing-photos`} target="_blank" className="btn-secondary flex-1 whitespace-nowrap px-3">
                ⬇️ 📷 {t('packingPhotos')}
              </a>
            )}
            <Link href={`/batches/${batch.id}/tnved`} className="btn-secondary flex-1 whitespace-nowrap px-3">
              🏷 ТНВЭД
            </Link>
          </div>
          {/* The papers that travel with the truck. Same fence as the card
              itself — a declaration is not more secret than the manifest. */}
          <div className="border-t border-line pt-2">
            <p className="section-title">📎 {t('documents')}</p>
            <AttachmentsPanel
              entityType="batch"
              entityId={batch.id}
              initial={batchFiles}
              editable={actor.permissions.has('ved.docs') || canVehicle}
            />
          </div>
          {actor.permissions.has('ved.docs') && (
            <form action={setSentToAgentAction}>
              <input type="hidden" name="batchId" value={batch.id} />
              <button type="submit" className={`w-full rounded-lg border-2 border-dashed p-2.5 text-sm font-semibold ${batch.sentToAgentAt ? 'border-green-500 bg-good/10 text-good' : 'border-line-strong text-ink-700'}`}>
                {batch.sentToAgentAt
                  ? `✅ ${t('sentToAgent')}: ${format.dateTime(new Date(batch.sentToAgentAt), { dateStyle: 'short' })}`
                  : `📤 ${t('markSentToAgent')}`}
              </button>
            </form>
          )}
        </Panel>
      )}

      {/* Rastamojka has a panel of its own, and it is deliberately NOT inside
          the VED papers. It shipped there, folded inside another fold, and the
          owner reported the feature as missing — a collapsed panel with
          nothing on its face is invisible whatever it holds (round 43). The
          badge names the firm on the collapsed card, so the answer to "who is
          clearing this truck" needs no tap at all. */}
      {(actor.permissions.has('ved.docs') || actor.permissions.has('plans.manage')) && (
        <Panel title={`🛃 ${t('customs')}`} badge={customsBadge} testId="batch-customs-panel">
          <CustomsFirm
            batchId={batch.id}
            partnerId={batch.customsPartnerId}
            byClient={batch.customsByClient}
            partners={customsPartners}
            canEdit={actor.permissions.has('ved.docs')}
          />
          {/* His third case: inside one truck some clients clear their own
              cargo and we clear the rest, so the answer lives per prixod
              with the truck's as the default. */}
          <CustomsPerReceipt
            batchId={batch.id}
            rows={customsRows}
            partners={customsPartners}
            canEdit={actor.permissions.has('ved.docs')}
          />
        </Panel>
      )}

      {/* Truck and driver: folded, and below the papers (owner). Editable
          until the batch closes — a wrong plate must be fixable even after
          departure. The summary carries the plate so a collapsed panel still
          answers "which truck is this". */}
      <Panel
        title={`🚛 ${t('vehicleTitle')}`}
        badge={batch.vehiclePlate || undefined}
      >
        {canVehicle && !['closed', 'cancelled'].includes(batch.status) ? (
          <VehicleForm
            batchId={batch.id}
            vehiclePlate={batch.vehiclePlate ?? ''}
            driverName={batch.driverName ?? ''}
            driverPhone={batch.driverPhone ?? ''}
          />
        ) : (
          <p className="text-sm">
            <span className="font-mono font-bold">{batch.vehiclePlate || '—'}</span>
            {batch.driverName && ` · ${batch.driverName}`}
            {batch.driverPhone && ` · ${batch.driverPhone}`}
          </p>
        )}
      </Panel>


      {/* Driver phone (owner's flow): while the truck is being loaded the
          warehouse worker installs the app on the driver's phone and types
          this code once. Android then streams real positions; iPhone /
          HarmonyOS stay on the manual pins below.

          Folded away by default (owner: "it should sit somewhere small where
          it bothers nobody") — it is touched once per trip, at loading. The
          badge shows a pending code so it is still findable at a glance. */}
      {canVehicle && !['closed', 'cancelled'].includes(batch.status) && (
        <Panel
          title={`📲 ${t('driverPhone')}`}
          badge={devices.find((d) => d.pairCode)?.pairCode ?? (devices.length > 0 ? '✅' : undefined)}
          testId="batch-driver-panel"
        >
          {devices.length === 0 && <p className="text-xs text-ink-500">{t('driverPhoneHint')}</p>}
          {/* The door the phone row always had, put back where he looks for
              it (owner: «ulangan telefonni kirgizganda tagida kartaga o'tish
              havolasi turar edi»). Round 46 folded «Где машина» into its own
              panel and the map link folded away WITH it — still there, but
              two taps deep with nothing on this panel saying so. A paired
              phone on a moving truck IS the reason somebody opens the map. */}
          {batch.status === 'in_transit' && devices.some((d) => !d.pairCode) && (
            <Link
              href="/map"
              className="block text-sm font-semibold text-brand-700 underline"
              data-testid="device-map-link"
            >
              🗺 {t('openMap')} →
            </Link>
          )}
          {devices.map((device) => (
            <div key={device.id} className="flex flex-wrap items-center gap-2 border-b border-line pb-2 text-sm last:border-0">
              {device.pairCode ? (
                <>
                  <span className="font-mono text-2xl font-extrabold tracking-widest text-brand-700">
                    {device.pairCode}
                  </span>
                  <span className="text-xs text-ink-500">{t('pairCodeHint')}</span>
                </>
              ) : (
                <span className="font-semibold text-good">
                  ✅ {device.label || t('driverPhone')}
                  {device.lastSeenAt
                    ? ` · ${t('lastSeen', { when: format.dateTime(new Date(device.lastSeenAt), { dateStyle: 'short', timeStyle: 'short' }) })}`
                    : ` · ${t('noFixesYet')}`}
                  {device.fixes > 0 && ` · ${device.fixes} 📍`}
                </span>
              )}
              <form action={revokeDriverDeviceAction} className="ml-auto">
                <input type="hidden" name="deviceId" value={device.id} />
                <input type="hidden" name="batchId" value={batch.id} />
                <button type="submit" className="text-xs font-semibold text-bad underline">
                  ✖ {tc('delete')}
                </button>
              </form>
            </div>
          ))}
          <form action={createDriverDeviceAction} className="flex flex-wrap gap-2">
            <input type="hidden" name="batchId" value={batch.id} />
            <input
              name="label"
              className="input min-w-40 flex-1"
              placeholder={batch.driverName || t('driverPhoneLabel')}
              maxLength={100}
            />
            <button type="submit" className="btn-secondary whitespace-nowrap px-3">
              📲 {t('newPairCode')}
            </button>
          </form>
        </Panel>
      )}

      {/* Tracking map pins: the logist marks where the truck ACTUALLY is —
          the map's estimate re-anchors from that moment (owner's feature). */}
      {batch.status === 'in_transit' && canVehicle && (
        // Folded like every other rail panel (owner): three buttons and a map
        // link are worth a tap, not a permanent block of the card.
        <Panel
          title={`📍 ${t('whereIsTruck')}`}
          badge={
            (batch.trackingCheckpoint as { key?: string } | null)?.key
              ? t(
                  `cp${((batch.trackingCheckpoint as { key: string }).key === 'at_border'
                    ? 'Border'
                    : (batch.trackingCheckpoint as { key: string }).key === 'in_kg'
                      ? 'Kg'
                      : 'Uz') as 'cpBorder'}`,
                )
              : undefined
          }
          testId="batch-where-panel"
        >
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['at_border', `🛃 ${t('cpBorder')}`],
                ['in_kg', `🇰🇬 ${t('cpKg')}`],
                ['in_uz', `🇺🇿 ${t('cpUz')}`],
              ] as const
            ).map(([key, label]) => {
              const active =
                (batch.trackingCheckpoint as { key?: string } | null)?.key === key;
              return (
                <form key={key} action={setTrackingCheckpointAction} className="flex-1">
                  <input type="hidden" name="batchId" value={batch.id} />
                  <input type="hidden" name="key" value={key} />
                  <button
                    type="submit"
                    className={`w-full whitespace-nowrap rounded-lg border-2 px-3 py-2 text-sm font-semibold ${
                      active ? 'border-blue-700 bg-brand-50 text-brand-700' : 'border-line text-ink-700'
                    }`}
                  >
                    {label}
                  </button>
                </form>
              );
            })}
          </div>
          <Link href="/map" className="text-sm font-semibold text-brand-700 underline">
            🗺 {t('openMap')} →
          </Link>
        </Panel>
      )}

      {/* Phase 2.1: VED manager + accountant set each client's negotiated
          price after customs — charges land in the client ledger. */}
      {actor.permissions.has('finance.manage') && (
        <Link
          href={`/batches/${batch.id}/pricing`}
          className="card block text-center font-bold text-warn hover:bg-warn/10"
        >
          💰 {t('pricing')}
        </Link>
      )}

      <TasksPanel
        entityType="batch"
        entityId={batch.id}
        revalidate={`/batches/${batch.id}`}
      />

      <CustomFieldsPanel
        entityType="batch"
        entityId={batch.id}
        revalidate={`/batches/${batch.id}`}
      />
          </>
        }
      />
    </div>
  );
}
