import Link from 'next/link';
import { desc, eq, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { boxes, clients, receiptLots, receipts, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { warehouseScope } from '@/modules/platform/rbac/scope';

export default async function ReceiptsPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('receipts');
  const format = await getFormatter();

  const rows = await db
    .select({
      receipt: receipts,
      warehouseCode: warehouses.code,
      clientCode: clients.clientCode,
      lotCount: sql<number>`(SELECT count(*) FROM ${receiptLots} WHERE ${receiptLots.receiptId} = ${receipts.id})`,
      boxCount: sql<number>`(SELECT count(*) FROM ${boxes} b JOIN ${receiptLots} rl ON b.lot_id = rl.id WHERE rl.receipt_id = ${receipts.id})`,
    })
    .from(receipts)
    .innerJoin(warehouses, eq(receipts.warehouseId, warehouses.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(
      warehouseScope(actor, receipts.warehouseId),
    )
    .orderBy(desc(receipts.receivedAt))
    .limit(100);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{t('title')}</h1>
        <Link href="/receive" className="btn-primary">
          📥
        </Link>
      </div>
      {rows.length === 0 && <p className="text-ink-500">{t('empty')}</p>}
      <div className="space-y-2">
        {rows.map(({ receipt, warehouseCode, clientCode, lotCount, boxCount }) => (
          <Link
            key={receipt.id}
            href={`/receipts/${receipt.id}`}
            className={`card block !p-3 hover:bg-surface-sunken ${receipt.status === 'voided' ? 'opacity-50' : ''}`}
          >
            <div className="flex items-baseline gap-2">
              <span className="font-mono font-bold">{receipt.number}</span>
              <span
                className={`font-mono font-extrabold ${clientCode ? 'text-brand-700' : 'text-orange-600'}`}
              >
                {clientCode ?? `❓ ${t('unclaimed')}`}
              </span>
              <span className="ml-auto text-xs text-ink-500">
                {format.dateTime(receipt.receivedAt, { dateStyle: 'short', timeStyle: 'short' })}
              </span>
            </div>
            <div className="mt-1 text-sm text-ink-700">
              {warehouseCode} · {lotCount} {t('lots').toLowerCase()} · {boxCount} 📦 ·{' '}
              {t(`statuses.${receipt.status}`)}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
