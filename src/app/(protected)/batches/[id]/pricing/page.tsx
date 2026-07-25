import { and, eq, sql } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clients,
  currencies,
  receiptLots,
  receipts,
} from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { batchCharges } from '@/modules/wms/finance/service';
import { BackLink } from '@/components/back-link';
import { PricingForm } from './pricing-form';
import { PageHeader } from '@/components/ui/page';

/**
 * Batch pricing (Phase 2.1, owner's flow): when the cargo is through customs
 * and ready, the VED manager + accountant set each client's negotiated price
 * here — every saved price becomes a ledger charge tied to this batch.
 */
export default async function BatchPricingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.manage')) redirect('/');
  const t = await getTranslations('finance');

  const batch = await db.query.batches.findFirst({ where: eq(batches.id, id) });
  if (!batch) notFound();

  // Clients on the batch: departed movements are the ground truth; before
  // departure fall back to current members (same rule as the cost sheet).
  const departed = await db
    .select({
      clientId: receipts.clientId,
      clientCode: clients.clientCode,
      clientName: clients.name,
      boxCount: sql<number>`count(distinct ${boxes.id})`,
      kg: sql<string>`coalesce(sum(${receiptLots.totalWeightKg} / ${receiptLots.boxCount}), 0)`,
      m3: sql<string>`coalesce(sum(${receiptLots.totalVolumeM3} / ${receiptLots.boxCount}), 0)`,
    })
    .from(boxMovements)
    .innerJoin(boxes, eq(boxMovements.boxId, boxes.id))
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .innerJoin(clients, eq(receipts.clientId, clients.id))
    .where(
      and(
        eq(boxMovements.refType, 'batch'),
        eq(boxMovements.refId, id),
        eq(boxMovements.cause, 'batch_departed'),
      ),
    )
    .groupBy(receipts.clientId, clients.clientCode, clients.name);
  const current = departed.length
    ? []
    : await db
        .select({
          clientId: receipts.clientId,
          clientCode: clients.clientCode,
          clientName: clients.name,
          boxCount: sql<number>`count(distinct ${boxes.id})`,
          kg: sql<string>`coalesce(sum(${receiptLots.totalWeightKg} / ${receiptLots.boxCount}), 0)`,
          m3: sql<string>`coalesce(sum(${receiptLots.totalVolumeM3} / ${receiptLots.boxCount}), 0)`,
        })
        .from(boxes)
        .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
        .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
        .innerJoin(clients, eq(receipts.clientId, clients.id))
        .where(eq(boxes.currentBatchId, id))
        .groupBy(receipts.clientId, clients.clientCode, clients.name);
  const clientRows = (departed.length ? departed : current)
    .filter((r) => r.clientId)
    .sort((a, b) => (a.clientCode ?? '').localeCompare(b.clientCode ?? ''));

  const [charges, currencyRows] = await Promise.all([
    batchCharges(id),
    db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true)),
  ]);
  const chargedByClient = new Map<string, number>();
  for (const { tx } of charges) {
    chargedByClient.set(tx.clientId, (chargedByClient.get(tx.clientId) ?? 0) + Number(tx.amountUsd));
  }
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-2xl">
      <BackLink href={`/batches/${id}`} label={batch.code} />
      <PageHeader icon="wallet" title={t('pricingTitle')} />
      <p className="text-sm text-gray-500">{t('pricingHint')}</p>

      {clientRows.length === 0 && <p className="text-sm text-gray-500">{t('empty')}</p>}
      {clientRows.map((row) => {
        const chargedUsd = chargedByClient.get(row.clientId!) ?? 0;
        return (
          <div key={row.clientId} className="card space-y-2">
            <div className="flex items-baseline gap-2">
              <Link href={`/finance/${row.clientId}`} className="font-mono text-lg font-extrabold text-blue-800">
                {row.clientCode}
              </Link>
              <span className="truncate text-sm text-gray-600">{row.clientName}</span>
              <span className="ml-auto whitespace-nowrap text-sm font-semibold">
                {row.boxCount} 📦 · {Math.round(Number(row.kg) * 10) / 10} kg ·{' '}
                {Math.round(Number(row.m3) * 1000) / 1000} m³
              </span>
            </div>
            {chargedUsd > 0 && (
              <p className="text-sm font-semibold text-green-700">
                ✅ {t('alreadyCharged')}: ${chargedUsd.toFixed(2)}
              </p>
            )}
            <PricingForm
              clientId={row.clientId!}
              batchId={id}
              currencies={currencyRows.map((c) => c.code)}
              today={today}
            />
          </div>
        );
      })}
    </div>
  );
}
