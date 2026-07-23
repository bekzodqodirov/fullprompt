import Link from 'next/link';
import { desc, eq, inArray } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { batches, loadPlans, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';

const STATUS_COLORS: Record<string, string> = {
  pending_agent: 'bg-orange-100 text-orange-800',
  changes_requested: 'bg-red-100 text-red-800',
  approved: 'bg-green-100 text-green-800',
  loading: 'bg-blue-100 text-blue-800',
  completed: 'bg-gray-100 text-gray-600',
};

export default async function PlansPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('plans.manage')) redirect('/');
  const t = await getTranslations('plans');
  const tc = await getTranslations('common');
  const format = await getFormatter();

  const dest = aliasedTable(warehouses, 'dest');
  const rows = await db
    .select({
      plan: loadPlans,
      originCode: warehouses.code,
      destCode: dest.code,
      batchCode: batches.code,
    })
    .from(loadPlans)
    .innerJoin(warehouses, eq(loadPlans.originWarehouseId, warehouses.id))
    .innerJoin(dest, eq(loadPlans.destWarehouseId, dest.id))
    .leftJoin(batches, eq(loadPlans.batchId, batches.id))
    .where(
      actor.warehouseScoped && actor.warehouseIds.length
        ? inArray(loadPlans.originWarehouseId, actor.warehouseIds)
        : undefined,
    )
    .orderBy(desc(loadPlans.createdAt))
    .limit(100);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">🚛 {t('title')}</h1>
        <Link href="/plans/new" className="btn-primary px-4">
          ＋ {t('newTitle')}
        </Link>
      </div>
      {rows.length === 0 && <p className="text-gray-500">{tc('empty')}</p>}
      <div className="space-y-2">
        {rows.map(({ plan, originCode, destCode, batchCode }) => (
          <Link key={plan.id} href={`/plans/${plan.id}`} className="card block !p-3 hover:bg-gray-50">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono font-extrabold">
                {originCode} → {destCode}
              </span>
              <span
                className={`rounded px-2 py-0.5 text-xs font-semibold ${STATUS_COLORS[plan.status] ?? 'bg-gray-100'}`}
              >
                {t(`statuses.${plan.status}`)}
              </span>
              {batchCode && <span className="font-mono font-bold text-blue-800">{batchCode}</span>}
              <span className="ml-auto text-xs text-gray-500">
                v{plan.currentVersionNo} · {format.dateTime(plan.createdAt, { dateStyle: 'short' })}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
