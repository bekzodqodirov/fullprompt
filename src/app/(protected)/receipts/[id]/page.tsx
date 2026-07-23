import { asc, eq, inArray } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  attachments,
  clients,
  costEntries,
  costTypes,
  receiptLots,
  receipts,
  warehouses,
} from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { HistoryTab } from '@/components/history-tab';
import { PhotoGallery } from '@/components/photo-gallery';
import { voidReceiptAction } from './actions';
import { AssignClient } from './assign-client';
import { LotEditForm } from './lot-edit-form';

export default async function ReceiptDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const { id } = await params;

  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, id) });
  if (!receipt) notFound();

  const t = await getTranslations('receipts');
  const tc = await getTranslations('common');
  const format = await getFormatter();

  const warehouse = (await db.query.warehouses.findFirst({
    where: eq(warehouses.id, receipt.warehouseId),
  }))!;
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
    .select({ entry: costEntries, typeName: costTypes.name })
    .from(costEntries)
    .innerJoin(costTypes, eq(costEntries.costTypeId, costTypes.id))
    .where(eq(costEntries.receiptId, id));

  const canVoid = actor.permissions.has('receipts.void') && receipt.status === 'confirmed';
  const canPrint = actor.permissions.has('receipts.create');
  const canEdit = actor.permissions.has('receipts.edit') && receipt.status === 'confirmed';
  const canAssign = actor.permissions.has('receipts.unclaimed.resolve') && receipt.status === 'confirmed';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">
          <span className="font-mono">{receipt.number}</span>
        </h1>
        <span
          className={`rounded px-2 py-0.5 text-sm font-semibold ${
            receipt.status === 'confirmed'
              ? 'bg-green-100 text-green-800'
              : receipt.status === 'voided'
                ? 'bg-red-100 text-red-800'
                : 'bg-gray-100'
          }`}
        >
          {t(`statuses.${receipt.status}`)}
        </span>
        {canPrint && receipt.status === 'confirmed' && (
          <a href={`/api/receipts/${id}/labels`} target="_blank" className="btn-primary ml-auto">
            🖨 {t('reprint')}
          </a>
        )}
      </div>

      <div className="card !p-3 text-sm">
        <p>
          <span className="font-semibold">{t('client')}: </span>
          {client ? (
            <span className="font-mono font-extrabold text-blue-800">
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
        {receipt.sourceNote && <p className="text-gray-600">{receipt.sourceNote}</p>}
        {receipt.voidReason && (
          <p className="font-semibold text-red-700">
            {t('voidReason')}: {receipt.voidReason}
          </p>
        )}
      </div>

      <section className="space-y-3">
        {lots.map((lot) => (
          <div key={lot.id} className="card !p-3">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-2xl font-extrabold text-blue-800">{lot.letter}</span>
              <span className="font-semibold">
                {lot.productNameZh}
                {lot.productNameRu && (
                  <span className="font-normal text-gray-600"> ({lot.productNameRu})</span>
                )}
              </span>
              {canPrint && receipt.status === 'confirmed' && (
                <a
                  href={`/api/receipts/${id}/labels?lotId=${lot.id}`}
                  target="_blank"
                  className="btn-secondary !min-h-9 ml-auto px-2 text-sm"
                >
                  🖨
                </a>
              )}
            </div>
            <p className="mt-1 text-sm text-gray-600">
              {lot.boxCount} 📦 · {lot.totalWeightKg} kg · {lot.totalVolumeM3} m³
              {lot.dimsMode === 'uniform' &&
                ` · ${lot.boxLengthCm}×${lot.boxWidthCm}×${lot.boxHeightCm} cm`}
              {lot.piecesCount && ` · ${lot.piecesCount} pcs`}
            </p>
            <div className="mt-2">
              <PhotoGallery photos={photosByLot.get(lot.id) ?? []} />
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
                    piecesCount: lot.piecesCount,
                  }}
                />
              </div>
            )}
          </div>
        ))}
      </section>

      {canAssign && <AssignClient receiptId={id} current={client?.clientCode ?? null} />}

      {costs.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-bold">{t('costs')}</h2>
          <ul className="card divide-y divide-gray-100 !p-0 text-sm">
            {costs.map(({ entry, typeName }) => (
              <li key={entry.id} className="flex gap-2 p-3">
                <span>{typeName}</span>
                <span className="ml-auto font-semibold">
                  {entry.amount} {entry.currency}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {canVoid && (
        <form action={voidReceiptAction} className="card space-y-2">
          <input type="hidden" name="receiptId" value={id} />
          <label className="label" htmlFor="void-reason">
            {t('voidReason')}
          </label>
          <input id="void-reason" name="reason" className="input" required minLength={3} />
          <button type="submit" className="btn-danger w-full">
            {t('voidBtn')}
          </button>
        </form>
      )}

      <section>
        <h2 className="mb-2 text-lg font-bold">{tc('history')}</h2>
        <HistoryTab entityType="receipt" entityId={id} />
      </section>
    </div>
  );
}
