import { asc, desc, eq, inArray } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  loadPlanLines,
  loadPlans,
  loadPlanVersions,
  truckPresets,
  warehouses,
} from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PlanEditor } from './plan-editor';

export default async function NewPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ planId?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('plans.manage')) redirect('/');
  const t = await getTranslations('plans');
  const { planId } = await searchParams;

  const whs = await db
    .select({ id: warehouses.id, code: warehouses.code })
    .from(warehouses)
    .where(
      actor.warehouseScoped && actor.warehouseIds.length
        ? inArray(warehouses.id, actor.warehouseIds)
        : undefined,
    )
    .orderBy(asc(warehouses.code));
  const presets = await db
    .select()
    .from(truckPresets)
    .where(eq(truckPresets.active, true))
    .orderBy(asc(truckPresets.name));

  let resubmit;
  if (planId) {
    const plan = await db.query.loadPlans.findFirst({ where: eq(loadPlans.id, planId) });
    if (plan && ['changes_requested', 'pending_agent'].includes(plan.status)) {
      const version = await db.query.loadPlanVersions.findFirst({
        where: eq(loadPlanVersions.planId, planId),
        orderBy: desc(loadPlanVersions.versionNo),
      });
      const lines = version
        ? await db.select().from(loadPlanLines).where(eq(loadPlanLines.versionId, version.id))
        : [];
      resubmit = {
        planId: plan.id,
        originWarehouseId: plan.originWarehouseId,
        destWarehouseId: plan.destWarehouseId,
        truckPresetId: plan.truckPresetId,
        lines: lines
          .filter((l) => !l.crateId)
          .map((l) => ({ lotId: l.lotId, boxCount: l.plannedBoxCount })),
        crateIds: [...new Set(lines.map((l) => l.crateId).filter((id): id is string => !!id))],
      };
    }
  }

  return (
    <div className="mx-auto max-w-lg md:max-w-4xl">
      <h1 className="mb-3 text-xl font-bold">🚛 {resubmit ? t('resubmitTitle') : t('newTitle')}</h1>
      <PlanEditor
        warehouses={whs}
        presets={presets.map((p) => ({
          id: p.id,
          name: p.name,
          maxKg: Number(p.maxKg),
          maxM3: Number(p.maxM3),
        }))}
        resubmit={resubmit}
      />
    </div>
  );
}
