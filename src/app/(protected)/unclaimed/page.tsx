import Link from 'next/link';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { boxes, receiptLots, receipts, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader } from '@/components/ui/page';
import { warehouseScope } from '@/modules/platform/rbac/scope';

/** Unclaimed pool (spec 6.7) — resolution actions arrive in M2. */
export default async function UnclaimedPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('receipts');
  const tc = await getTranslations('common');
  const format = await getFormatter();

  const rows = await db
    .select({
      receipt: receipts,
      whCode: warehouses.code,
      boxCount: sql<number>`(SELECT count(*) FROM ${boxes} b JOIN ${receiptLots} rl ON b.lot_id = rl.id WHERE rl.receipt_id = ${receipts.id})`,
    })
    .from(receipts)
    .innerJoin(warehouses, eq(receipts.warehouseId, warehouses.id))
    .where(
      and(
        isNull(receipts.clientId),
        eq(receipts.status, 'confirmed'),
        warehouseScope(actor, receipts.warehouseId),
      ),
    )
    .orderBy(desc(receipts.receivedAt))
    .limit(100);

  return (
    <div className="space-y-4">
      <PageHeader icon="alert" title={t('unclaimedTitle')} />
      {rows.length === 0 && <p className="text-ink-500">{tc('empty')}</p>}
      <div className="space-y-2">
        {rows.map(({ receipt, whCode, boxCount }) => (
          <Link
            key={receipt.id}
            href={`/receipts/${receipt.id}`}
            className="card block !p-3 hover:bg-surface-sunken"
          >
            <div className="flex items-baseline gap-2">
              <span className="font-mono font-bold">{receipt.number}</span>
              <span className="ml-auto text-xs text-ink-500">
                {format.dateTime(receipt.receivedAt, { dateStyle: 'short' })}
              </span>
            </div>
            <p className="text-sm text-ink-700">
              {whCode} · {boxCount} 📦 {receipt.sourceNote && `· ${receipt.sourceNote}`}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
