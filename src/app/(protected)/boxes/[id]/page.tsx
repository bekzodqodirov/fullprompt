import { asc, eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  boxMovements,
  boxes,
  clients,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { boxLandedCost } from '@/modules/wms/costing/service';
import { BoxStatusActions } from './status-actions';
import { BackLink } from '@/components/back-link';

/** Box card: identity + full movement timeline (spec 5.5 / §10). */
export default async function BoxPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const { id } = await params;

  const box = await db.query.boxes.findFirst({ where: eq(boxes.id, id) });
  if (!box) notFound();
  const t = await getTranslations('stock');
  const format = await getFormatter();

  const lot = (await db.query.receiptLots.findFirst({ where: eq(receiptLots.id, box.lotId) }))!;
  const receipt = (await db.query.receipts.findFirst({ where: eq(receipts.id, lot.receiptId) }))!;
  const client = receipt.clientId
    ? await db.query.clients.findFirst({ where: eq(clients.id, receipt.clientId) })
    : null;
  const wh = box.currentWarehouseId
    ? await db.query.warehouses.findFirst({ where: eq(warehouses.id, box.currentWarehouseId) })
    : null;

  const canSeeCosts =
    actor.permissions.has('costs.enter_batch') ||
    actor.permissions.has('costs.enter_receipt') ||
    actor.permissions.has('reports.all_warehouses');
  const landed = canSeeCosts ? await boxLandedCost(box.id) : null;
  const tCost = await getTranslations('costing');

  const movements = await db
    .select({ movement: boxMovements, actorName: users.fullName, toWh: warehouses.code })
    .from(boxMovements)
    .leftJoin(users, eq(boxMovements.actorId, users.id))
    .leftJoin(warehouses, eq(boxMovements.toWarehouseId, warehouses.id))
    .where(eq(boxMovements.boxId, id))
    .orderBy(asc(boxMovements.createdAt));

  return (
    <div className="space-y-4">
      <BackLink href="/stock" label={t('title')} />
      <h1 className="font-mono text-xl font-extrabold">{box.shortCode}</h1>
      <div className="card !p-3 text-sm">
        <p className="text-lg">
          <span className="font-mono font-extrabold text-brand-700">
            {client?.clientCode ?? '❓'}-{lot.letter}
          </span>{' '}
          · {box.seqInLot}/{lot.boxCount} {t('inLot')}
        </p>
        <p>
          {lot.productNameZh} {lot.productNameRu && `(${lot.productNameRu})`}
        </p>
        <p className="mt-1">
          <span className="rounded bg-surface-sunken px-2 py-0.5 font-semibold">
            {t(`statuses.${box.status}`)}
          </span>{' '}
          {wh && <span className="font-mono font-bold">{wh.code}</span>}
          {box.statusReason && <span className="ml-2 text-xs text-ink-500">({box.statusReason})</span>}
        </p>
        <p className="mt-1 text-ink-500">
          {receipt.number}
          {box.labelPrintedAt &&
            ` · 🖨 ${format.dateTime(box.labelPrintedAt, { dateStyle: 'short', timeStyle: 'short' })}`}
        </p>
      </div>

      {actor.permissions.has('receipts.void') && (
        <BoxStatusActions boxId={box.id} status={box.status} inCrate={box.crateId !== null} />
      )}

      {landed && landed.shares.length > 0 && (
        <section className="card !p-3 text-sm">
          <h2 className="mb-1 text-lg font-bold">
            💰 {tCost('landedCost')}: <span className="font-mono">${landed.totalUsd}</span>
          </h2>
          <ul className="divide-y divide-line">
            {landed.shares.map((share, i) => (
              <li key={i} className="flex flex-wrap gap-2 py-1">
                <span>{share.typeName}</span>
                <span className="text-ink-500">
                  {share.batchCode ?? share.crateCode ?? tCost('scopeReceipt')}
                </span>
                <span className="ml-auto font-mono font-semibold">
                  ${Math.round(Number(share.amountUsd) * 100) / 100}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-lg font-bold">{t('timeline')}</h2>
        <ol className="space-y-2">
          {movements.map(({ movement, actorName, toWh }) => (
            <li key={String(movement.id)} className="card !p-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-semibold">{t(`statuses.${movement.toStatus}`)}</span>
                {toWh && <span className="font-mono font-bold">{toWh}</span>}
                <span className="text-ink-500">({movement.cause})</span>
                <span className="ml-auto text-xs text-ink-500">
                  {format.dateTime(movement.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
                </span>
              </div>
              {actorName && <p className="text-xs text-ink-500">{actorName}</p>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
