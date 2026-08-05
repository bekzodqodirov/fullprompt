import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  attachments,
  clients,
  costEntries,
  costTypes,
  partners,
  currencies,
  deals,
  receiptLots,
  receipts,
  warehouses,
} from '@/modules/platform/db/schema';
import { CostPanel } from '@/components/cost-panel';
import { getActor } from '@/modules/platform/rbac/authorize';
import { HistoryTab } from '@/components/history-tab';
import { PhotoGallery } from '@/components/photo-gallery';
import { AttachmentsPanel } from '@/components/attachments-panel';
import { VoidReceiptForm } from './void-form';
import { AssignClient } from './assign-client';
import { LotEditForm } from './lot-edit-form';
import { DealLink } from './deal-link';
import { MoveReceipt } from './move-receipt';
import { ReturnToSender } from './return-to-sender';
import { canWriteDeal, openDealsForClient } from '@/modules/wms/deals/service';
import { BackLink } from '@/components/back-link';
import { CustomFieldsPanel } from '@/components/custom-fields-panel';
import { PrintLabels } from '@/components/print-labels';
import { TasksPanel } from '@/components/tasks-panel';
import { inScope } from '@/modules/platform/rbac/scope';
import { listPartners } from '@/modules/wms/partners/service';

export default async function ReceiptDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const { id } = await params;

  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, id) });
  if (!receipt) notFound();
  // The LIST is warehouse-filtered and this was not, so a uuid from a
  // colleague's link opened another warehouse's cargo.
  if (!inScope(actor, receipt.warehouseId)) notFound();

  const t = await getTranslations('receipts');
  const tc = await getTranslations('common');
  const format = await getFormatter();

  const warehouse = (await db.query.warehouses.findFirst({
    where: eq(warehouses.id, receipt.warehouseId),
  }))!;
  const allWarehouses = await db
    .select({ id: warehouses.id, code: warehouses.code })
    .from(warehouses)
    .orderBy(asc(warehouses.code));
  const client = receipt.clientId
    ? await db.query.clients.findFirst({ where: eq(clients.id, receipt.clientId) })
    : null;
  const lots = await db
    .select()
    .from(receiptLots)
    .where(eq(receiptLots.receiptId, id))
    .orderBy(asc(receiptLots.seq));

  const lotIds = lots.map((l) => l.id);
  const photoRows = lotIds.length
    ? await db
        .select({ id: attachments.id, fileName: attachments.fileName, entityId: attachments.entityId })
        .from(attachments)
        .where(inArray(attachments.entityId, lotIds))
    : [];
  const photosByLot = new Map<string, { id: string; fileName: string }[]>();
  for (const photo of photoRows) {
    photosByLot.set(photo.entityId, [...(photosByLot.get(photo.entityId) ?? []), photo]);
  }

  const costs = await db
    .select({ entry: costEntries, typeName: costTypes.name, partnerName: partners.name })
    .from(costEntries)
    .innerJoin(costTypes, eq(costEntries.costTypeId, costTypes.id))
    .leftJoin(partners, eq(costEntries.partnerId, partners.id))
    .where(and(eq(costEntries.receiptId, id), isNull(costEntries.voidedAt)));
  const canEnterCosts = actor.permissions.has('costs.enter_receipt');
  const costMeta = canEnterCosts
    ? {
        types: await db
          .select({ id: costTypes.id, code: costTypes.code, name: costTypes.name })
          .from(costTypes)
          .where(eq(costTypes.active, true)),
        currencies: (
          await db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true))
        ).map((c) => c.code),
      }
    : null;

  const receiptFiles = await db
    .select({
      id: attachments.id,
      fileName: attachments.fileName,
      contentType: attachments.contentType,
      kind: attachments.kind,
    })
    .from(attachments)
    .where(and(eq(attachments.entityType, 'receipt'), eq(attachments.entityId, id)));

  // Who settled a cost is asked HERE too (owner: «skladchilar rasxodni
  // kiritganda kim tomondan berilgani yozilmayabti»). The warehouse enters
  // most of the money on a prixod, so the choice has to be where they are.
  const partnerOptions = canEnterCosts
    ? (await listPartners()).map((row) => ({ id: row.id, name: row.name }))
    : [];

  const canVoid = actor.permissions.has('receipts.void') && receipt.status === 'confirmed';
  const canPrint = actor.permissions.has('receipts.create');
  const canEdit = actor.permissions.has('receipts.edit') && receipt.status === 'confirmed';
  const canAssign = actor.permissions.has('receipts.unclaimed.resolve') && receipt.status === 'confirmed';

  // Which job this cargo belongs to — shown, and correctable, from the cargo
  // itself. Only to somebody who may write deals: to everybody else a deal
  // code is a link into a screen they cannot open.
  const canLinkDeal = canWriteDeal(actor.permissions) && Boolean(receipt.clientId);
  const linkedDeal = receipt.dealId
    ? ((await db.query.deals.findFirst({ where: eq(deals.id, receipt.dealId) })) ?? null)
    : null;
  const dealOptions = canLinkDeal ? await openDealsForClient(receipt.clientId!) : [];
  // A deal that has since been won or lost is not in the open list, and
  // hiding it would hide the very mistake being corrected.
  const dealChoices =
    linkedDeal && !dealOptions.some((d) => d.id === linkedDeal.id)
      ? [{ id: linkedDeal.id, code: linkedDeal.code, title: linkedDeal.title }, ...dealOptions]
      : dealOptions;

  return (
    <div className="space-y-6">
      <BackLink href="/receipts" label={t('title')} />
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">
          <span className="font-mono">{receipt.number}</span>
        </h1>
        <span
          className={`rounded px-2 py-0.5 text-sm font-semibold ${
            receipt.status === 'confirmed'
              ? 'bg-good/15 text-good'
              : receipt.status === 'voided'
                ? 'bg-bad/15 text-bad'
                : 'bg-surface-sunken'
          }`}
        >
          {t(`statuses.${receipt.status}`)}
        </span>
        {canPrint && receipt.status === 'confirmed' && (
          <div className="ml-auto w-44">
            <PrintLabels href={`/print/receipts/${id}`} label={t('reprint')} />
          </div>
        )}
      </div>

      <div className="card !p-3 text-sm">
        <p>
          <span className="font-semibold">{t('client')}: </span>
          {client ? (
            <span className="font-mono font-extrabold text-brand-700">
              {client.clientCode} — {client.name}
            </span>
          ) : (
            <span className="font-bold text-orange-600">
              ❓ {t('unclaimed')}
              {receipt.unclaimedMarking && (
                <span className="ml-2 rounded bg-orange-100 px-2 py-0.5 font-mono">
                  {receipt.unclaimedMarking}
                </span>
              )}
            </span>
          )}
        </p>
        <p>
          <span className="font-semibold">{t('date')}: </span>
          {format.dateTime(receipt.receivedAt, { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
          {warehouse.code}
        </p>
        {receipt.sourceNote && <p className="text-ink-700">{receipt.sourceNote}</p>}
        {receipt.voidReason && (
          <p className="font-semibold text-bad">
            {t('voidReason')}: {receipt.voidReason}
          </p>
        )}
      </div>

      {canLinkDeal && (
        <DealLink
          receiptId={id}
          current={linkedDeal ? { id: linkedDeal.id, code: linkedDeal.code } : null}
          options={dealChoices}
        />
      )}

      <section className="space-y-3">
        {lots.map((lot) => (
          <div key={lot.id} className="card !p-3">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-2xl font-extrabold text-brand-700">{lot.letter}</span>
              <span className="font-semibold">
                {lot.productNameZh}
                {lot.productNameRu && (
                  <span className="font-normal text-ink-700"> ({lot.productNameRu})</span>
                )}
              </span>
              {canPrint && receipt.status === 'confirmed' && (
                <div className="ml-auto w-28">
                  <PrintLabels
                    variant="secondary"
                    href={`/print/receipts/${id}?lotId=${lot.id}`}
                    label={lot.letter ?? ''}
                  />
                </div>
              )}
            </div>
            <p className="mt-1 text-sm text-ink-700">
              {lot.boxCount} 📦 · {lot.totalWeightKg} kg · {lot.totalVolumeM3} m³
              {lot.dimsMode === 'uniform' &&
                ` · ${lot.boxLengthCm}×${lot.boxWidthCm}×${lot.boxHeightCm} cm`}
            </p>
            {lot.note && <p className="mt-1 text-sm italic text-ink-500">📝 {lot.note}</p>}
            <div className="mt-2">
              <PhotoGallery photos={photosByLot.get(lot.id) ?? []} deletable={canEdit} />
            </div>
            {canEdit && (
              <div className="mt-2">
                <LotEditForm
                  lot={{
                    lotId: lot.id,
                    dimsMode: lot.dimsMode,
                    productNameZh: lot.productNameZh,
                    productNameRu: lot.productNameRu ?? '',
                    boxCount: lot.boxCount,
                    boxLengthCm: lot.boxLengthCm,
                    boxWidthCm: lot.boxWidthCm,
                    boxHeightCm: lot.boxHeightCm,
                    boxWeightKg: lot.boxWeightKg,
                    totalWeightKg: lot.totalWeightKg,
                    totalVolumeM3: lot.totalVolumeM3,
                    note: lot.note,
                  }}
                />
              </div>
            )}
          </div>
        ))}
      </section>

      {canAssign && <AssignClient receiptId={id} current={client?.clientCode ?? null} />}
      {canAssign && !client && <ReturnToSender receiptId={id} />}
      {canVoid && (
        <MoveReceipt
          receiptId={id}
          currentWarehouseId={receipt.warehouseId}
          warehouses={allWarehouses}
        />
      )}

      <section className="card space-y-3">
        <div>
          <h2 className="mb-2 text-lg font-bold">{t('attachments')}</h2>
          <AttachmentsPanel
            entityType="receipt"
            entityId={id}
            initial={receiptFiles}
            editable={canEdit}
          />
        </div>
        {costMeta ? (
          <div className="border-t border-line pt-3">
            <h2 className="mb-2 text-lg font-bold">{t('costs')}</h2>
            <CostPanel
              scope="receipt"
              targetId={id}
              entries={costs.map(({ entry, typeName, partnerName }) => ({
                id: entry.id,
                typeName,
                amount: entry.amount,
                currency: entry.currency,
                amountUsd: entry.amountUsd,
                costDate: entry.costDate,
                allocationBasis: entry.allocationBasis,
                note: entry.note,
                partnerName,
              }))}
              costTypes={costMeta.types}
              currencies={costMeta.currencies}
              clientOptions={client ? [{ id: client.id, clientCode: client.clientCode }] : []}
              defaultCurrency={warehouse.country === 'CN' ? 'CNY' : 'USD'}
              canEdit={receipt.status === 'confirmed'}
              partnerOptions={partnerOptions}
            />
          </div>
        ) : costs.length > 0 && (
          <div className="border-t border-line pt-3">
            <h2 className="mb-2 text-lg font-bold">{t('costs')}</h2>
            <ul className="divide-y divide-line text-sm">
              {costs.map(({ entry, typeName }) => (
                <li key={entry.id} className="flex flex-wrap gap-2 py-2">
                  <span>{typeName}</span>
                  <span className="font-semibold">
                    {entry.amount} {entry.currency}
                  </span>
                  {entry.note && <span className="w-full text-xs text-ink-500">{entry.note}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {canVoid && (
        <VoidReceiptForm
          receiptId={id}
          labels={{
            reason: t('voidReason'),
            button: t('voidBtn'),
            errors: {
              box_not_in_stock: t('voidBoxGone'),
              receipt_has_costs: t('voidHasCosts'),
            },
          }}
        />
      )}

      <TasksPanel
        entityType="receipt"
        entityId={id}
        revalidate={`/receipts/${id}`}
      />

      <CustomFieldsPanel
        entityType="receipt"
        entityId={id}
        revalidate={`/receipts/${id}`}
      />

      <section>
        <h2 className="mb-2 text-lg font-bold">{tc('history')}</h2>
        <HistoryTab entityType="receipt" entityId={id} />
      </section>
    </div>
  );
}
