import Link from 'next/link';
import { desc, eq, inArray } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { batches, loadPlans, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader } from '@/components/ui/page';

const STATUS_COLORS: Record<string, string> = {
  pending_agent: 'bg-orange-100 text-orange-800',
  changes_requested: 'bg-bad/15 text-bad',
  approved: 'bg-good/15 text-good',
  loading: 'bg-brand-100 text-brand-700',
  completed: 'bg-surface-sunken text-ink-700',
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
      <PageHeader icon="truck" title={t('title')}
        actions={
          <Link href="/plans/new" className="btn-primary px-4">
          ＋ {t('newTitle')}
        </Link>
        }
      />
      {rows.length === 0 && <p className="text-ink-500">{tc('empty')}</p>}
      <div className="space-y-2">
        {rows.map(({ plan, originCode, destCode, batchCode }) => (
          <Link key={plan.id} href={`/plans/${plan.id}`} className="card block !p-3 hover:bg-surface-sunken">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono font-extrabold">
                {originCode} → {destCode}
              </span>
              <span
                className={`rounded px-2 py-0.5 text-xs font-semibold ${STATUS_COLORS[plan.status] ?? 'bg-surface-sunken'}`}
              >
                {t(`statuses.${plan.status}`)}
              </span>
              {batchCode && <span className="font-mono font-bold text-brand-700">{batchCode}</span>}
              <span className="ml-auto text-xs text-ink-500">
                v{plan.currentVersionNo} · {format.dateTime(plan.createdAt, { dateStyle: 'short' })}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
