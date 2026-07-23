import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  loadPlanLines,
  loadPlans,
  loadPlanVersions,
  receiptLots,
  truckPresets,
  warehouses,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';
import { nextBatchCode } from '../codes';

export class PlanError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(code);
  }
}

export const planLineSchema = z.object({
  lotId: z.string().uuid(),
  boxCount: z.number().int().min(1).max(10_000),
});

export const submitPlanSchema = z.object({
  /** Present on resubmit after changes_requested. */
  planId: z.string().uuid().optional(),
  originWarehouseId: z.string().uuid(),
  destWarehouseId: z.string().uuid(),
  truckPresetId: z.string().uuid().optional(),
  maxKg: z.number().positive().max(100_000).optional(),
  maxM3: z.number().positive().max(1_000).optional(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lines: z.array(planLineSchema).min(1).max(500),
});
export type SubmitPlanInput = z.infer<typeof submitPlanSchema>;

/**
 * How many boxes of a lot are still available to plan: in_stock at the
 * origin WH and not reserved by another batch.
 */
export async function availableByLot(originWarehouseId: string, lotIds: string[]) {
  if (lotIds.length === 0) return new Map<string, number>();
  const rows = await db
    .select({ lotId: boxes.lotId, n: sql<number>`count(*)` })
    .from(boxes)
    .where(
      and(
        inArray(boxes.lotId, lotIds),
        eq(boxes.status, 'in_stock'),
        eq(boxes.currentWarehouseId, originWarehouseId),
      ),
    )
    .groupBy(boxes.lotId);
  return new Map(rows.map((r) => [r.lotId, Number(r.n)]));
}

/**
 * Submit a plan version to the agent (W3). The editor keeps its draft
 * client-side; the first submit creates the plan (status pending_agent),
 * a resubmit after changes_requested adds version N+1. Versions are
 * immutable snapshots.
 */
export async function submitPlan(input: SubmitPlanInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new PlanError('unauthenticated');
  const actorId = ctx.actorId;
  if (input.originWarehouseId === input.destWarehouseId) throw new PlanError('same_warehouse');

  return db.transaction(async (tx) => {
    const lotIds = input.lines.map((l) => l.lotId);
    const lots = await tx
      .select()
      .from(receiptLots)
      .where(inArray(receiptLots.id, lotIds));
    if (lots.length !== lotIds.length) throw new PlanError('lot_not_found');
    const lotById = new Map(lots.map((l) => [l.id, l]));

    const available = await availableByLot(input.originWarehouseId, lotIds);
    for (const line of input.lines) {
      const free = available.get(line.lotId) ?? 0;
      if (line.boxCount > free) {
        throw new PlanError('insufficient_stock', `${line.lotId}:${free}`);
      }
    }

    // Per-line kg/m³ pro-rated from the lot totals.
    const computed = input.lines.map((line) => {
      const lot = lotById.get(line.lotId)!;
      const perBoxKg = Number(lot.totalWeightKg) / lot.boxCount;
      const perBoxM3 = Number(lot.totalVolumeM3) / lot.boxCount;
      return {
        ...line,
        kg: Math.round(perBoxKg * line.boxCount * 1000) / 1000,
        m3: Math.round(perBoxM3 * line.boxCount * 10_000) / 10_000,
      };
    });
    const totalBoxes = computed.reduce((a, l) => a + l.boxCount, 0);
    const totalKg = Math.round(computed.reduce((a, l) => a + l.kg, 0) * 1000) / 1000;
    const totalM3 = Math.round(computed.reduce((a, l) => a + l.m3, 0) * 10_000) / 10_000;

    let preset = null;
    if (input.truckPresetId) {
      preset = await tx.query.truckPresets.findFirst({
        where: eq(truckPresets.id, input.truckPresetId),
      });
      if (!preset) throw new PlanError('preset_not_found');
    }
    const maxKg = input.maxKg ?? (preset ? Number(preset.maxKg) : null);
    const maxM3 = input.maxM3 ?? (preset ? Number(preset.maxM3) : null);

    let plan;
    if (input.planId) {
      plan = await tx.query.loadPlans.findFirst({ where: eq(loadPlans.id, input.planId) });
      if (!plan) throw new PlanError('plan_not_found');
      if (!['changes_requested', 'pending_agent'].includes(plan.status)) {
        throw new PlanError('plan_not_editable');
      }
      [plan] = await tx
        .update(loadPlans)
        .set({
          truckPresetId: input.truckPresetId ?? plan.truckPresetId,
          maxKg: maxKg != null ? String(maxKg) : plan.maxKg,
          maxM3: maxM3 != null ? String(maxM3) : plan.maxM3,
          targetDate: input.targetDate ?? plan.targetDate,
          status: 'pending_agent',
          currentVersionNo: plan.currentVersionNo + 1,
        })
        .where(eq(loadPlans.id, plan.id))
        .returning();
    } else {
      [plan] = await tx
        .insert(loadPlans)
        .values({
          originWarehouseId: input.originWarehouseId,
          destWarehouseId: input.destWarehouseId,
          truckPresetId: input.truckPresetId ?? null,
          maxKg: maxKg != null ? String(maxKg) : null,
          maxM3: maxM3 != null ? String(maxM3) : null,
          targetDate: input.targetDate ?? null,
          status: 'pending_agent',
          currentVersionNo: 1,
          createdBy: actorId,
        })
        .returning();
    }

    const [version] = await tx
      .insert(loadPlanVersions)
      .values({
        planId: plan!.id,
        versionNo: plan!.currentVersionNo,
        submittedBy: actorId,
        totalBoxes,
        totalKg: String(totalKg),
        totalM3: String(totalM3),
      })
      .returning();
    await tx.insert(loadPlanLines).values(
      computed.map((line) => ({
        versionId: version!.id,
        lotId: line.lotId,
        plannedBoxCount: line.boxCount,
        plannedKg: String(line.kg),
        plannedM3: String(line.m3),
      })),
    );

    await writeAudit(tx, { ...ctx, warehouseId: input.originWarehouseId }, {
      entityType: 'load_plan',
      entityId: plan!.id,
      action: input.planId ? 'update' : 'create',
      after: { versionNo: plan!.currentVersionNo, totalBoxes, totalKg, totalM3 },
    });
    return { plan: plan!, version: version! };
  });
}

export const verdictSchema = z.object({
  versionId: z.string().uuid(),
  verdict: z.enum(['approved', 'changes_requested']),
  comment: z.string().trim().max(2000).optional().or(z.literal('')),
});
export type VerdictInput = z.infer<typeof verdictSchema>;

/**
 * The agent stays outside the system (owner's rule): the logist relays the
 * verdict here. `approved` creates the batch and reserves concrete boxes
 * (lowest seq_in_lot first — actual identity is fixed at scan time anyway).
 */
export async function recordVerdict(input: VerdictInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new PlanError('unauthenticated');
  const actorId = ctx.actorId;
  return db.transaction(async (tx) => {
    const version = await tx.query.loadPlanVersions.findFirst({
      where: eq(loadPlanVersions.id, input.versionId),
    });
    if (!version) throw new PlanError('version_not_found');
    if (version.agentVerdict) throw new PlanError('verdict_already_recorded');
    const plan = (await tx.query.loadPlans.findFirst({
      where: eq(loadPlans.id, version.planId),
    }))!;
    if (plan.status !== 'pending_agent' || plan.currentVersionNo !== version.versionNo) {
      throw new PlanError('version_not_current');
    }

    await tx
      .update(loadPlanVersions)
      .set({
        agentVerdict: input.verdict,
        agentComment: input.comment || null,
        verdictRecordedBy: actorId,
        verdictRecordedAt: new Date(),
      })
      .where(eq(loadPlanVersions.id, version.id));

    if (input.verdict === 'changes_requested') {
      await tx.update(loadPlans).set({ status: 'changes_requested' }).where(eq(loadPlans.id, plan.id));
      await writeAudit(tx, { ...ctx, warehouseId: plan.originWarehouseId }, {
        entityType: 'load_plan',
        entityId: plan.id,
        action: 'status_change',
        after: { status: 'changes_requested', versionNo: version.versionNo, comment: input.comment || null },
      });
      await emitEvent(tx, {
        type: 'PlanChangesRequested',
        payload: { planId: plan.id, versionNo: version.versionNo, comment: input.comment || null },
        entityType: 'load_plan',
        entityId: plan.id,
        actorId,
      });
      return { plan: { ...plan, status: 'changes_requested' as const }, batch: null };
    }

    // Approved → batch + reservation.
    const origin = (await tx.query.warehouses.findFirst({
      where: eq(warehouses.id, plan.originWarehouseId),
    }))!;
    const code = await nextBatchCode(tx, origin);
    const [batch] = await tx
      .insert(batches)
      .values({
        code,
        originWarehouseId: plan.originWarehouseId,
        destWarehouseId: plan.destWarehouseId,
        type: 'transfer',
        status: 'forming',
        createdBy: actorId,
      })
      .returning();

    const lines = await tx
      .select()
      .from(loadPlanLines)
      .where(eq(loadPlanLines.versionId, version.id));
    for (const line of lines) {
      const candidates = await tx
        .select()
        .from(boxes)
        .where(
          and(
            eq(boxes.lotId, line.lotId),
            eq(boxes.status, 'in_stock'),
            eq(boxes.currentWarehouseId, plan.originWarehouseId),
          ),
        )
        .orderBy(asc(boxes.seqInLot))
        .limit(line.plannedBoxCount)
        .for('update');
      if (candidates.length < line.plannedBoxCount) {
        throw new PlanError('insufficient_stock', line.lotId);
      }
      const ids = candidates.map((b) => b.id);
      await tx
        .update(boxes)
        .set({ status: 'planned', currentBatchId: batch!.id })
        .where(inArray(boxes.id, ids));
      await tx.insert(boxMovements).values(
        candidates.map((box) => ({
          boxId: box.id,
          fromWarehouseId: box.currentWarehouseId,
          toWarehouseId: box.currentWarehouseId,
          fromStatus: box.status,
          toStatus: 'planned',
          cause: 'plan_approved',
          refType: 'batch',
          refId: batch!.id,
          actorId,
        })),
      );
    }

    const [updatedPlan] = await tx
      .update(loadPlans)
      .set({ status: 'approved', batchId: batch!.id })
      .where(eq(loadPlans.id, plan.id))
      .returning();
    await writeAudit(tx, { ...ctx, warehouseId: plan.originWarehouseId }, {
      entityType: 'load_plan',
      entityId: plan.id,
      action: 'status_change',
      after: { status: 'approved', batchCode: code, versionNo: version.versionNo },
    });
    await emitEvent(tx, {
      type: 'PlanApproved',
      payload: { planId: plan.id, batchId: batch!.id, batchCode: code, versionNo: version.versionNo },
      entityType: 'load_plan',
      entityId: plan.id,
      actorId,
    });
    return { plan: updatedPlan!, batch: batch! };
  });
}
