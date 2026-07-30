import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clients,
  clientTransactions,
  currencies,
  receiptLots,
  receipts,
} from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { batchCharges } from '@/modules/wms/finance/service';
import { batchLandedCostByClient } from '@/modules/wms/costing/service';
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

  const [charges, currencyRows, landed] = await Promise.all([
    batchCharges(id),
    db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true)),
    batchLandedCostByClient(id),
  ]);
  const chargedByClient = new Map<string, number>();
  for (const { tx } of charges) {
    chargedByClient.set(tx.clientId, (chargedByClient.get(tx.clientId) ?? 0) + Number(tx.amountUsd));
  }
  const today = new Date().toISOString().slice(0, 10);

  // «Kim qancha to'ladi» on the same screen (round 29): the client's OVERALL
  // balance — payments are money on the account, not on a truck, so this is
  // honestly labelled the general balance, not this batch's.
  const clientIds = clientRows.map((row) => row.clientId!).filter(Boolean);
  const balanceRows = clientIds.length
    ? await db
        .select({
          clientId: clientTransactions.clientId,
          balance: sql<string>`coalesce(sum(CASE WHEN ${clientTransactions.type} = 'charge' THEN ${clientTransactions.amountUsd} ELSE -${clientTransactions.amountUsd} END), 0)`,
        })
        .from(clientTransactions)
        .where(
          and(
            inArray(clientTransactions.clientId, clientIds),
            isNull(clientTransactions.voidedAt),
          ),
        )
        .groupBy(clientTransactions.clientId)
    : [];
  const balanceByClient = new Map(
    balanceRows.map((row) => [row.clientId, Math.round(Number(row.balance) * 100) / 100]),
  );

  // Batch totals, so the header answers "did this truck earn money?" before
  // anyone scrolls through twenty clients.
  const totalCost = clientRows.reduce((a, r) => a + (landed.get(r.clientId!)?.totalUsd ?? 0), 0);
  const totalCharged = clientRows.reduce((a, r) => a + (chargedByClient.get(r.clientId!) ?? 0), 0);
  const priced = clientRows.filter((r) => (chargedByClient.get(r.clientId!) ?? 0) > 0).length;
  const money = (value: number) => `$${value.toFixed(2)}`;

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-2xl">
      <BackLink href={`/batches/${id}`} label={batch.code} />
      <PageHeader icon="wallet" title={t('pricingTitle')} />
      <p className="text-sm text-ink-500">{t('pricingHint')}</p>

      {clientRows.length > 0 && (
        <div className="card grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-xs uppercase tracking-wide text-ink-500">{t('costLabel')}</p>
            <p className="num text-lg font-extrabold">{money(totalCost)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-ink-500">{t('priceLabel')}</p>
            <p className="num text-lg font-extrabold">{money(totalCharged)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-ink-500">{t('marginLabel')}</p>
            <p
              className={`num text-lg font-extrabold ${
                totalCharged - totalCost >= 0 ? 'text-good' : 'text-bad'
              }`}
            >
              {money(totalCharged - totalCost)}
            </p>
          </div>
          <p className="col-span-3 text-xs text-ink-500">
            {t('pricedOf', { priced, total: clientRows.length })}
          </p>
        </div>
      )}

      {clientRows.length === 0 && <p className="text-sm text-ink-500">{t('empty')}</p>}
      {clientRows.map((row) => {
        const chargedUsd = chargedByClient.get(row.clientId!) ?? 0;
        const cost = landed.get(row.clientId!);
        const costUsd = cost?.totalUsd ?? 0;
        const kg = Math.round(Number(row.kg) * 10) / 10;
        const m3 = Math.round(Number(row.m3) * 1000) / 1000;
        // Margin only means something once a price exists; before that the
        // row would read as a 100 % loss on every client.
        const margin = chargedUsd > 0 ? chargedUsd - costUsd : null;
        return (
          <div key={row.clientId} className="card space-y-2">
            <div className="flex items-baseline gap-2">
              <Link href={`/finance/${row.clientId}`} className="font-mono text-lg font-extrabold text-brand-700">
                {row.clientCode}
              </Link>
              <span className="truncate text-sm text-ink-700">{row.clientName}</span>
              <span className="ml-auto whitespace-nowrap text-sm font-semibold">
                {row.boxCount} 📦 · {kg} kg · {m3} m³
              </span>
            </div>

            {/* Cost → price → margin, the three numbers the price is decided
                from (owner). The customs entered once for the whole truck
                reaches this row as this client's share. */}
            <div className="grid grid-cols-3 gap-2 rounded-lg bg-surface-sunken p-2 text-center text-sm">
              <div>
                <p className="text-xs text-ink-500">{t('costLabel')}</p>
                <p className="num font-bold" data-testid="client-cost">
                  {money(costUsd)}
                </p>
                {kg > 0 && costUsd > 0 && (
                  <p className="num text-xs text-ink-500">
                    {(costUsd / kg).toFixed(2)}/kg
                    {m3 > 0 && ` · ${(costUsd / m3).toFixed(0)}/m³`}
                  </p>
                )}
              </div>
              <div>
                <p className="text-xs text-ink-500">{t('priceLabel')}</p>
                <p className="num font-bold">{chargedUsd > 0 ? money(chargedUsd) : '—'}</p>
                {chargedUsd > 0 && kg > 0 && (
                  <p className="num text-xs text-ink-500">{(chargedUsd / kg).toFixed(2)}/kg</p>
                )}
              </div>
              <div>
                <p className="text-xs text-ink-500">{t('marginLabel')}</p>
                <p className={`num font-bold ${margin === null ? '' : margin >= 0 ? 'text-good' : 'text-bad'}`}>
                  {margin === null ? '—' : money(margin)}
                </p>
                {margin !== null && chargedUsd > 0 && (
                  <p className="num text-xs text-ink-500">
                    {Math.round((margin / chargedUsd) * 100)}%
                  </p>
                )}
              </div>
            </div>
            {costUsd === 0 && (
              <p className="text-xs text-warn">⚠️ {t('noCostsYet')}</p>
            )}

            {balanceByClient.has(row.clientId!) && (
              <p className="text-sm">
                {t('clientBalance')}:{' '}
                <span
                  className={`num font-bold ${
                    balanceByClient.get(row.clientId!)! > 0.009 ? 'text-bad' : 'text-good'
                  }`}
                >
                  {money(balanceByClient.get(row.clientId!)!)}
                </span>
                <Link href={`/finance/${row.clientId}`} className="ml-2 text-xs text-brand-700 underline">
                  {t('openLedger')} →
                </Link>
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
