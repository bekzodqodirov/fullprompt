import Link from 'next/link';
import { asc, desc, eq } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  batches,
  clients,
  crates,
  loadPlanLines,
  loadPlans,
  loadPlanVersions,
  receiptLots,
  receipts,
  warehouses,
} from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { VerdictForm } from './verdict-form';
import { BackLink } from '@/components/back-link';
import { CustomFieldsPanel } from '@/components/custom-fields-panel';
import { TasksPanel } from '@/components/tasks-panel';

export default async function PlanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('plans.manage')) redirect('/');
  const t = await getTranslations('plans');
  const format = await getFormatter();

  const dest = aliasedTable(warehouses, 'dest');
  const rows = await db
    .select({ plan: loadPlans, originCode: warehouses.code, destCode: dest.code, batchCode: batches.code })
    .from(loadPlans)
    .innerJoin(warehouses, eq(loadPlans.originWarehouseId, warehouses.id))
    .innerJoin(dest, eq(loadPlans.destWarehouseId, dest.id))
    .leftJoin(batches, eq(loadPlans.batchId, batches.id))
    .where(eq(loadPlans.id, id))
    .limit(1);
  const hit = rows[0];
  if (!hit) notFound();
  const { plan, originCode, destCode, batchCode } = hit;

  const versions = await db
    .select()
    .from(loadPlanVersions)
    .where(eq(loadPlanVersions.planId, id))
    .orderBy(desc(loadPlanVersions.versionNo));
  const current = versions[0];

  const lines = current
    ? await db
        .select({
          line: loadPlanLines,
          lot: receiptLots,
          clientCode: clients.clientCode,
          marking: receipts.unclaimedMarking,
          crateCode: crates.code,
        })
        .from(loadPlanLines)
        .innerJoin(receiptLots, eq(loadPlanLines.lotId, receiptLots.id))
        .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
        .leftJoin(clients, eq(receipts.clientId, clients.id))
        .leftJoin(crates, eq(loadPlanLines.crateId, crates.id))
        .where(eq(loadPlanLines.versionId, current.id))
        .orderBy(asc(loadPlanLines.id))
    : [];

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <BackLink href="/plans" label={t('title')} />
      <div className="card space-y-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="font-mono text-xl font-extrabold">
            {originCode} → {destCode}
          </h1>
          <span className="rounded bg-surface-sunken px-2 py-0.5 text-sm font-semibold">
            {t(`statuses.${plan.status}`)}
          </span>
          {batchCode && (
            <Link href={`/batches/${plan.batchId}`} className="font-mono font-bold text-brand-700">
              {batchCode} →
            </Link>
          )}
        </div>
        {current && (
          <p className="text-sm text-ink-700">
            v{current.versionNo} · {current.totalBoxes} 📦 · {current.totalKg} kg · {current.totalM3} m³
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <a
            href={`/api/plans/${plan.id}/xlsx`}
            target="_blank"
            className="btn-secondary flex-1 whitespace-nowrap px-3"
          >
            ⬇️ {t('agentXlsx')}
          </a>
          {plan.status === 'changes_requested' && (
            <Link href={`/plans/new?planId=${plan.id}`} className="btn-primary flex-1 whitespace-nowrap px-3">
              ✏️ {t('editResubmit')}
            </Link>
          )}
        </div>
      </div>

      {plan.status === 'pending_agent' && current && <VerdictForm versionId={current.id} />}

      <div className="card space-y-1">
        <h2 className="text-lg font-bold">{t('lines')}</h2>
        {lines.map(({ line, lot, clientCode, marking, crateCode }) => (
          <div key={line.id} className="flex items-baseline gap-2 border-b border-line py-1.5 text-sm last:border-0">
            <span className="font-mono font-extrabold text-brand-700">
              {clientCode ?? marking ?? '?'}-{lot.letter}
            </span>
            {crateCode && (
              <span className="whitespace-nowrap rounded bg-warn/15 px-1.5 text-xs font-semibold text-warn">
                🧰 {crateCode}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">
              {lot.productNameZh}
              {lot.productNameRu && <span className="text-ink-500"> ({lot.productNameRu})</span>}
            </span>
            <span className="font-semibold">
              {line.plannedBoxCount}/{lot.boxCount} 📦
            </span>
            <span className="whitespace-nowrap text-ink-500">
              {line.plannedKg} kg · {line.plannedM3} m³
            </span>
          </div>
        ))}
      </div>

      <div className="card space-y-2">
        <h2 className="text-lg font-bold">{t('versionHistory')}</h2>
        {versions.map((v) => (
          <div key={v.id} className="rounded-lg border border-line p-2 text-sm">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-bold">v{v.versionNo}</span>
              <span>{v.totalBoxes} 📦 · {v.totalKg} kg · {v.totalM3} m³</span>
              {v.agentVerdict && (
                <span
                  className={`rounded px-2 py-0.5 text-xs font-semibold ${
                    v.agentVerdict === 'approved'
                      ? 'bg-good/15 text-good'
                      : 'bg-bad/15 text-bad'
                  }`}
                >
                  {v.agentVerdict === 'approved' ? t('agentApproved') : t('agentChanges')}
                </span>
              )}
              <span className="ml-auto text-xs text-ink-500">
                {format.dateTime(v.submittedAt, { dateStyle: 'short', timeStyle: 'short' })}
              </span>
            </div>
            {v.agentComment && <p className="mt-1 text-xs text-ink-700">💬 {v.agentComment}</p>}
          </div>
        ))}
      </div>

      <TasksPanel
        entityType="plan"
        entityId={plan.id}
        revalidate={`/plans/${plan.id}`}
      />

      <CustomFieldsPanel
        entityType="plan"
        entityId={plan.id}
        revalidate={`/plans/${plan.id}`}
      />
    </div>
  );
}
