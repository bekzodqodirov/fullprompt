import { and, eq, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import { db, type Tx } from '../../platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clientTransactions,
  costEntries,
  crates,
  driverDevices,
  loadPlanLines,
  loadPlans,
  loadPlanVersions,
  receiptLots,
  receipts,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { cancelTasksFor } from '../../platform/tasks/service';
import { recomputeAll, recomputeEntry, scopeBoxIds, voidCostEntryInTx } from '../costing/service';
import { voidBoxRows } from './void-box';

/**
 * Anulirovka — the super-admin cascade void of a receipt (owner, 2026-08-26:
 * test data reached production and went through the WHOLE flow; «anulirovat
 * qilish mumkin bo'lsin … barcha finance rasxodlari ham unga tegishli
 * tozalanishi kerak»). voidReceipt's bigger brother: the same terminal state,
 * but it does not refuse on moved boxes and it voids the receipt's own money
 * in the SAME transaction — the design review's first blocker was a version
 * that committed the money voids before a refusable cargo step.
 *
 * Owner-only, by ROLE: no permission code can separate super_admin from admin
 * (both hold ALL), #170 forbids minting one, and he named super admin. One
 * predicate, so widening it later is a one-line decision.
 */
export function mayAnnul(actor: { roles: string[] }): boolean {
  return actor.roles.includes('super_admin');
}

export class AnnulError extends Error {
  constructor(
    public readonly code:
      | 'unauthenticated'
      | 'annul_forbidden'
      | 'reason_required'
      | 'not_found'
      | 'box_on_active_plan',
  ) {
    super(code);
  }
}

export interface AnnulResult {
  /** The receipt was already annulled — only the aftermath was re-run. */
  repaired: boolean;
  boxesVoided: number;
  costEntriesVoided: number;
  batchesRetired: string[];
  cratesDissolved: number;
  aftermath: AftermathResult;
}

interface AnnulActor {
  id: string;
  roles: string[];
}

/** Batches this receipt's boxes ever rode (durable movements + live pointer). */
async function riddenBatchIds(exec: Tx | typeof db, boxIds: string[]): Promise<string[]> {
  if (boxIds.length === 0) return [];
  const departed = await exec
    .selectDistinct({ id: boxMovements.refId })
    .from(boxMovements)
    .where(
      and(
        inArray(boxMovements.boxId, boxIds),
        eq(boxMovements.refType, 'batch'),
        eq(boxMovements.cause, 'batch_departed'),
      ),
    );
  const live = await exec
    .selectDistinct({ id: boxes.currentBatchId })
    .from(boxes)
    .where(inArray(boxes.id, boxIds));
  return [
    ...new Set(
      [...departed.map((r) => r.id), ...live.map((r) => r.id)].filter(
        (id): id is string => id !== null,
      ),
    ),
  ];
}

/** Crates this receipt's boxes were ever packed into (movements + live pointer). */
async function packedCrateIds(exec: Tx | typeof db, boxIds: string[]): Promise<string[]> {
  if (boxIds.length === 0) return [];
  const packed = await exec
    .selectDistinct({ id: boxMovements.refId })
    .from(boxMovements)
    .where(
      and(
        inArray(boxMovements.boxId, boxIds),
        eq(boxMovements.refType, 'crate'),
        eq(boxMovements.cause, 'crate_packed'),
      ),
    );
  const live = await exec
    .selectDistinct({ id: boxes.crateId })
    .from(boxes)
    .where(inArray(boxes.id, boxIds));
  return [
    ...new Set(
      [...packed.map((r) => r.id), ...live.map((r) => r.id)].filter(
        (id): id is string => id !== null,
      ),
    ),
  ];
}

async function receiptBoxIds(exec: Tx | typeof db, receiptId: string): Promise<string[]> {
  const rows = await exec
    .select({ id: boxes.id })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(eq(receiptLots.receiptId, receiptId));
  return rows.map((r) => r.id);
}

export async function annulReceipt(
  receiptId: string,
  reason: string,
  actor: AnnulActor,
  ctx: AuditContext,
): Promise<AnnulResult> {
  if (!ctx.actorId) throw new AnnulError('unauthenticated');
  // The service refuses too (#531): a hidden button is not a rule.
  if (!mayAnnul(actor)) throw new AnnulError('annul_forbidden');
  const why = reason.trim();
  if (why.length < 3) throw new AnnulError('reason_required');

  const existing = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
  if (!existing) throw new AnnulError('not_found');
  if (existing.voidedAt) {
    // Already annulled: the re-press IS the repair. A crash between the
    // stamp and the recompute must not be permanent, and 'already_voided'
    // was the design review's door that closed it for ever.
    const aftermath = await annulAftermath(receiptId, ctx);
    return {
      repaired: true,
      boxesVoided: 0,
      costEntriesVoided: 0,
      batchesRetired: [],
      cratesDissolved: 0,
      aftermath,
    };
  }

  const outcome = await db.transaction(async (tx) => {
    const receipt = await tx.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
    if (!receipt) throw new AnnulError('not_found');
    if (receipt.voidedAt) return null; // raced with another annul — aftermath below

    const lotRows = await tx
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .where(eq(receiptLots.receiptId, receiptId));
    const lotIds = lotRows.map((l) => l.id);
    const boxRows = lotIds.length
      ? await tx
          .select({
            id: boxes.id,
            status: boxes.status,
            statusReason: boxes.statusReason,
            crateId: boxes.crateId,
            currentBatchId: boxes.currentBatchId,
          })
          .from(boxes)
          .where(inArray(boxes.lotId, lotIds))
          .for('update')
      : [];

    // A box mid-operation stays refused: an approved plan reserved it, a
    // loading truck is being scanned against it. The fix is the plan/batch
    // cancel, which knows how to give everything back — checked HERE, under
    // the lock, so nothing was destroyed before a refusal (the review's C1).
    if (boxRows.some((b) => b.status === 'planned' || b.status === 'loading')) {
      throw new AnnulError('box_on_active_plan');
    }
    // A submitted plan has reserved NOTHING yet — its boxes are still
    // in_stock — but its lines name this receipt's lots, and annulling now
    // guarantees the agent's verdict dies mid-transaction on a bare
    // insufficient_stock (the exact shipped defect the crate guard records).
    if (lotIds.length) {
      const pending = await tx
        .select({ id: loadPlanLines.id })
        .from(loadPlanLines)
        .innerJoin(loadPlanVersions, eq(loadPlanLines.versionId, loadPlanVersions.id))
        .innerJoin(loadPlans, eq(loadPlanVersions.planId, loadPlans.id))
        .where(
          and(
            inArray(loadPlanLines.lotId, lotIds),
            eq(loadPlans.currentVersionNo, loadPlanVersions.versionNo),
            eq(loadPlans.status, 'pending_agent'),
          ),
        )
        .limit(1);
      if (pending.length) throw new AnnulError('box_on_active_plan');
    }

    // Money, in the SAME transaction: every live receipt-scope entry goes,
    // with its allocations and its partner charge (voidCostEntryInTx keeps
    // the #529 pairing). A refusal above or a crash rolls it all back.
    const liveEntries = await tx
      .select({ id: costEntries.id })
      .from(costEntries)
      .where(and(eq(costEntries.receiptId, receiptId), isNull(costEntries.voidedAt)));
    for (const entry of liveEntries) {
      await voidCostEntryInTx(tx, entry.id, `annul: ${why}`, ctx);
    }

    // Collected BEFORE the flip clears the live pointers.
    const boxIds = boxRows.map((b) => b.id);
    const batchIds = await riddenBatchIds(tx, boxIds);
    const crateIds = await packedCrateIds(tx, boxIds);
    const liveCrateIds = [
      ...new Set(boxRows.map((b) => b.crateId).filter((id): id is string => id !== null)),
    ];

    const toFlip = boxRows.filter((b) => b.status !== 'void');
    await voidBoxRows(tx, toFlip, {
      reasonText: `annulled: ${why}`,
      refId: receiptId,
      actorId: ctx.actorId ?? null,
    });

    // A crate the annul emptied must not stay an active, scannable place: it
    // rides every loading snapshot at its warehouse (round 110's 56 KB), and
    // dissolveCrate has anticipated the memberless case since round 31.
    let cratesDissolved = 0;
    for (const crateId of liveCrateIds) {
      const [left] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(boxes)
        .where(eq(boxes.crateId, crateId));
      if (Number(left!.n) === 0) {
        const [row] = await tx
          .update(crates)
          .set({ status: 'dissolved', dissolvedAt: new Date(), dissolvedBy: ctx.actorId })
          .where(and(eq(crates.id, crateId), eq(crates.status, 'active')))
          .returning({ id: crates.id });
        if (row) {
          cratesDissolved += 1;
          await writeAudit(tx, ctx, {
            entityType: 'crate',
            entityId: crateId,
            action: 'status_change',
            after: { status: 'dissolved', from: 'annul', receiptId },
          });
        }
      }
    }

    // A departed truck whose EVERY member is now void is a phantom: nobody
    // will ever unload it, cancelBatch refuses anything past loading, and
    // /transit, the map and the silent-truck alarm would serve it for ever.
    // Retiring it here is the annul finishing its own sentence.
    const batchesRetired: string[] = [];
    for (const batchId of batchIds) {
      const batch = await tx.query.batches.findFirst({ where: eq(batches.id, batchId) });
      if (!batch || !['in_transit', 'arrived'].includes(batch.status)) continue;
      const [live] = await tx
        .select({ n: sql<number>`count(distinct ${boxes.id})` })
        .from(boxes)
        .where(
          and(
            ne(boxes.status, 'void'),
            // `${boxes}.column`, not `${boxes.column}` — a single-table
            // select renders columns unqualified, and inside the EXISTS the
            // bare name binds to the SUBQUERY's table (#128).
            sql`(${boxes}.current_batch_id = ${batchId} or exists (
              select 1 from ${boxMovements} bm
              where bm.box_id = ${boxes}.id
                and bm.ref_type = 'batch' and bm.ref_id = ${batchId}
                and bm.cause = 'batch_departed'))`,
          ),
        );
      if (Number(live!.n) > 0) continue;
      await tx
        .update(driverDevices)
        .set({ revokedAt: new Date(), pairCode: null })
        .where(and(eq(driverDevices.batchId, batchId), isNull(driverDevices.revokedAt)));
      await cancelTasksFor(tx, 'batch', [batchId]);
      await tx.update(batches).set({ status: 'cancelled' }).where(eq(batches.id, batchId));
      await writeAudit(tx, { ...ctx, warehouseId: batch.originWarehouseId }, {
        entityType: 'batch',
        entityId: batchId,
        action: 'status_change',
        before: { status: batch.status },
        after: { status: 'cancelled', reason: `annul: ${why}`, receiptId },
      });
      batchesRetired.push(batch.code);
    }

    await tx
      .update(receipts)
      .set({ status: 'voided', voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: why })
      .where(eq(receipts.id, receiptId));
    await writeAudit(tx, { ...ctx, warehouseId: receipt.warehouseId }, {
      entityType: 'receipt',
      entityId: receiptId,
      action: 'void',
      after: {
        reason: why,
        annul: true,
        boxesVoided: toFlip.length,
        costEntriesVoided: liveEntries.length,
        batchesRetired,
        // The shared-truck redistribution runs AFTER this transaction; the
        // aftermath writes its own audit row when it lands.
        recomputePending: batchIds.length + crateIds.length,
      },
    });
    return { boxesVoided: toFlip.length, costEntriesVoided: liveEntries.length, batchesRetired, cratesDissolved };
  });

  const aftermath = await annulAftermath(receiptId, ctx);
  return {
    repaired: outcome === null,
    boxesVoided: outcome?.boxesVoided ?? 0,
    costEntriesVoided: outcome?.costEntriesVoided ?? 0,
    batchesRetired: outcome?.batchesRetired ?? [],
    cratesDissolved: outcome?.cratesDissolved ?? 0,
    aftermath,
  };
}

export interface AftermathResult {
  batchesRecomputed: number;
  crateEntriesRecomputed: number;
  emptyScopeVoided: number;
}

/**
 * The shared-money half, re-runnable: redistribute batch/crate costs off the
 * void boxes, then void any entry whose scope came back EMPTY — the all-test
 * truck's own freight, which otherwise stands in the P&L for ever, allocated
 * to nothing, with its partner debt live. Runs after the annul's transaction
 * (the lot-edit precedent: money must not roll back the cargo fix) and again
 * on every re-press of the annul button, so a crash here is never permanent.
 */
export async function annulAftermath(receiptId: string, ctx: AuditContext): Promise<AftermathResult> {
  const boxIds = await receiptBoxIds(db, receiptId);
  const batchIds = await riddenBatchIds(db, boxIds);
  const crateIds = await packedCrateIds(db, boxIds);

  let batchesRecomputed = 0;
  for (const batchId of batchIds) {
    await recomputeAll({ batchId });
    batchesRecomputed += 1;
  }
  const crateEntries = crateIds.length
    ? await db
        .select({ id: costEntries.id })
        .from(costEntries)
        .where(and(inArray(costEntries.crateId, crateIds), isNull(costEntries.voidedAt)))
    : [];
  for (const entry of crateEntries) await recomputeEntry(entry.id);

  // Empty-scope sweep. Judged on the SCOPE, not the allocation count: an
  // unconverted entry (no FX rate) also has zero allocations, and voiding it
  // for that would destroy money whose only problem is a missing rate.
  const scopeCond =
    batchIds.length && crateIds.length
      ? or(inArray(costEntries.batchId, batchIds), inArray(costEntries.crateId, crateIds))
      : batchIds.length
        ? inArray(costEntries.batchId, batchIds)
        : crateIds.length
          ? inArray(costEntries.crateId, crateIds)
          : null;
  const candidates = scopeCond
    ? await db
        .select()
        .from(costEntries)
        .where(and(isNull(costEntries.voidedAt), scopeCond))
    : [];
  let emptyScopeVoided = 0;
  for (const entry of candidates) {
    const scope = await scopeBoxIds(entry);
    if (scope.length > 0) continue;
    await db.transaction(async (tx) =>
      voidCostEntryInTx(tx, entry.id, 'annul: yuk qolmadi (scope empty)', ctx),
    );
    emptyScopeVoided += 1;
  }

  if (batchesRecomputed || crateEntries.length || emptyScopeVoided) {
    await writeAudit(db, ctx, {
      entityType: 'receipt',
      entityId: receiptId,
      action: 'update',
      after: {
        annulRecompute: {
          batches: batchesRecomputed,
          crateEntries: crateEntries.length,
          emptyScopeVoided,
        },
      },
    });
  }
  return { batchesRecomputed, crateEntriesRecomputed: crateEntries.length, emptyScopeVoided };
}

export interface AnnulPreview {
  boxesByStatus: Record<string, number>;
  liveCostEntries: number;
  liveCostUsd: number;
  unconvertedCostCount: number;
  affectedBatches: { code: string; status: string; willRetire: boolean }[];
  crateCount: number;
  pendingPlanCount: number;
  clientLiveTxCount: number;
}

/** What one press will do — information for the confirm, never input (#514). */
export async function annulPreview(receiptId: string): Promise<AnnulPreview | null> {
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
  if (!receipt) return null;
  const boxIds = await receiptBoxIds(db, receiptId);
  const statusRows = boxIds.length
    ? await db
        .select({ status: boxes.status, n: sql<number>`count(*)` })
        .from(boxes)
        .where(inArray(boxes.id, boxIds))
        .groupBy(boxes.status)
    : [];
  const boxesByStatus = Object.fromEntries(statusRows.map((r) => [r.status, Number(r.n)]));

  const entries = await db
    .select({ amountUsd: costEntries.amountUsd })
    .from(costEntries)
    .where(and(eq(costEntries.receiptId, receiptId), isNull(costEntries.voidedAt)));
  const liveCostUsd = entries.reduce((sum, e) => sum + (e.amountUsd ? Number(e.amountUsd) : 0), 0);
  const unconvertedCostCount = entries.filter((e) => e.amountUsd === null).length;

  const batchIds = await riddenBatchIds(db, boxIds);
  const affectedBatches: AnnulPreview['affectedBatches'] = [];
  for (const batchId of batchIds) {
    const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
    if (!batch) continue;
    let willRetire = false;
    if (['in_transit', 'arrived'].includes(batch.status)) {
      const [live] = await db
        .select({ n: sql<number>`count(distinct ${boxes.id})` })
        .from(boxes)
        .where(
          and(
            ne(boxes.status, 'void'),
            boxIds.length ? notInArray(boxes.id, boxIds) : undefined,
            sql`(${boxes}.current_batch_id = ${batchId} or exists (
              select 1 from ${boxMovements} bm
              where bm.box_id = ${boxes}.id
                and bm.ref_type = 'batch' and bm.ref_id = ${batchId}
                and bm.cause = 'batch_departed'))`,
          ),
        );
      willRetire = Number(live!.n) === 0;
    }
    affectedBatches.push({ code: batch.code, status: batch.status, willRetire });
  }

  const crateCount = (await packedCrateIds(db, boxIds)).length;

  const lotRows = await db
    .select({ id: receiptLots.id })
    .from(receiptLots)
    .where(eq(receiptLots.receiptId, receiptId));
  const lotIds = lotRows.map((l) => l.id);
  const pendingRows = lotIds.length
    ? await db
        .select({ id: loadPlanLines.id })
        .from(loadPlanLines)
        .innerJoin(loadPlanVersions, eq(loadPlanLines.versionId, loadPlanVersions.id))
        .innerJoin(loadPlans, eq(loadPlanVersions.planId, loadPlans.id))
        .where(
          and(
            inArray(loadPlanLines.lotId, lotIds),
            eq(loadPlans.currentVersionNo, loadPlanVersions.versionNo),
            eq(loadPlans.status, 'pending_agent'),
          ),
        )
    : [];

  // ALL of the client's live money, deliberately not a per-receipt heuristic:
  // a charge names no receipt, a payment names only its kassa, and «0» here
  // must never read as «clean» while test money stands in a cash box.
  const [liveTx] = receipt.clientId
    ? await db
        .select({ n: sql<number>`count(*)` })
        .from(clientTransactions)
        .where(
          and(eq(clientTransactions.clientId, receipt.clientId), isNull(clientTransactions.voidedAt)),
        )
    : [{ n: 0 }];

  return {
    boxesByStatus,
    liveCostEntries: entries.length,
    liveCostUsd,
    unconvertedCostCount,
    affectedBatches,
    crateCount,
    pendingPlanCount: pendingRows.length,
    clientLiveTxCount: Number(liveTx!.n),
  };
}
