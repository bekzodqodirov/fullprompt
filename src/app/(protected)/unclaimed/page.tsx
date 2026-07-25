import Link from 'next/link';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { boxes, receiptLots, receipts, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader } from '@/components/ui/page';

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
        actor.warehouseScoped && actor.warehouseIds.length
          ? inArray(receipts.warehouseId, actor.warehouseIds)
          : undefined,
      ),
    )
    .orderBy(desc(receipts.receivedAt))
    .limit(100);

  return (
    <div className="space-y-4">
      <PageHeader icon="alert" title={t('unclaimedTitle')} />
      {rows.length === 0 && <p className="text-gray-500">{tc('empty')}</p>}
      <div className="space-y-2">
        {rows.map(({ receipt, whCode, boxCount }) => (
          <Link
            key={receipt.id}
            href={`/receipts/${receipt.id}`}
            className="card block !p-3 hover:bg-gray-50"
          >
            <div className="flex items-baseline gap-2">
              <span className="font-mono font-bold">{receipt.number}</span>
              <span className="ml-auto text-xs text-gray-500">
                {format.dateTime(receipt.receivedAt, { dateStyle: 'short' })}
              </span>
            </div>
            <p className="text-sm text-gray-600">
              {whCode} · {boxCount} 📦 {receipt.sourceNote && `· ${receipt.sourceNote}`}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
