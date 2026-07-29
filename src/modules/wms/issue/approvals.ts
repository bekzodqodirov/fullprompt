import { and, desc, eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../../platform/db/client';
import { clients, issueApprovals, users, warehouses } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';
import { getSetting } from '../../platform/settings/service';
import { clientBalanceUsd, deferredBalanceUsd } from '../finance/service';

/**
 * Phase 6: permission to issue to a debtor becomes a RECORD.
 *
 * Today's escalation is a phone call and a checkbox that "leaves no reason
 * and no end date" (docs/DEALS.md's own criticism of it). This gives the
 * at-the-gate override the same discipline a deal deferral already has: who
 * asked, who allowed, why, until when — and the gate re-checks all of it at
 * read time, never trusting a status field alone.
 *
 * The direct checkbox stays for finance.debt_override holders standing at
 * the counter — a person allowed to decide should not petition themselves.
 */

export class ApprovalError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** The blocking figure, computed the same way the gate computes it. */
export async function blockingDebtUsd(clientId: string): Promise<number> {
  const [balance, deferred] = await Promise.all([
    clientBalanceUsd(clientId),
    deferredBalanceUsd(clientId),
  ]);
  return Math.round((balance - deferred) * 100) / 100;
}

export async function requestIssueApproval(
  input: { clientId: string; warehouseId: string; note?: string },
  ctx: AuditContext,
): Promise<{ id: string }> {
  if (!ctx.actorId) throw new ApprovalError('unauthenticated');
  const debt = await blockingDebtUsd(input.clientId);
  // Nothing to approve — the gate is already open.
  if (debt <= 0.009) throw new ApprovalError('no_debt');

  // One live request per (client, warehouse): a second row would only split
  // the deciders' attention across duplicates of the same question.
  const [live] = await db
    .select({ id: issueApprovals.id, status: issueApprovals.status, expiresAt: issueApprovals.expiresAt })
    .from(issueApprovals)
    .where(
      and(
        eq(issueApprovals.clientId, input.clientId),
        eq(issueApprovals.warehouseId, input.warehouseId),
        sql`${issueApprovals.status} IN ('pending', 'approved')`,
      ),
    )
    .orderBy(desc(issueApprovals.requestedAt))
    .limit(1);
  if (live?.status === 'pending') throw new ApprovalError('already_requested');
  if (live?.status === 'approved' && live.expiresAt && live.expiresAt.getTime() > Date.now()) {
    throw new ApprovalError('already_approved');
  }

  const [row] = await db
    .insert(issueApprovals)
    .values({
      clientId: input.clientId,
      warehouseId: input.warehouseId,
      blockingDebtUsd: String(debt),
      requestedBy: ctx.actorId,
      requestNote: input.note?.trim() || null,
    })
    .returning({ id: issueApprovals.id });

  await writeAudit(db, { ...ctx, warehouseId: input.warehouseId }, {
    entityType: 'issue_approval',
    entityId: row!.id,
    action: 'create',
    after: { clientId: input.clientId, blockingDebtUsd: debt },
  });

  const [client, wh, requester] = await Promise.all([
    db.query.clients.findFirst({ where: eq(clients.id, input.clientId) }),
    db.query.warehouses.findFirst({ where: eq(warehouses.id, input.warehouseId) }),
    db.query.users.findFirst({ where: eq(users.id, ctx.actorId) }),
  ]);
  await emitEvent(db, {
    type: 'DebtApprovalRequested',
    payload: {
      approvalId: row!.id,
      clientId: input.clientId,
      clientCode: client?.clientCode ?? '',
      clientName: client?.name ?? '',
      warehouseCode: wh?.code ?? '',
      blockingDebtUsd: debt,
      requestedByName: requester?.fullName ?? '',
      note: input.note?.trim() || null,
    },
    entityType: 'issue_approval',
    entityId: row!.id,
    actorId: ctx.actorId,
  });
  return { id: row!.id };
}

export async function decideIssueApproval(
  input: { approvalId: string; verdict: 'approved' | 'refused'; note?: string },
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) throw new ApprovalError('unauthenticated');
  const row = await db.query.issueApprovals.findFirst({
    where: eq(issueApprovals.id, input.approvalId),
  });
  if (!row) throw new ApprovalError('not_found');
  // Single-shot, like a plan verdict: the second decider learns the question
  // is closed instead of silently overwriting the first answer.
  if (row.status !== 'pending') throw new ApprovalError('already_decided');

  const ttlHours = Number(await getSetting('debt_approval_ttl_hours')) || 24;
  const expiresAt =
    input.verdict === 'approved' ? new Date(Date.now() + ttlHours * 3_600_000) : null;
  await db
    .update(issueApprovals)
    .set({
      status: input.verdict,
      decidedBy: ctx.actorId,
      decidedAt: new Date(),
      decisionNote: input.note?.trim() || null,
      expiresAt,
    })
    .where(eq(issueApprovals.id, input.approvalId));

  await writeAudit(db, { ...ctx, warehouseId: row.warehouseId }, {
    entityType: 'issue_approval',
    entityId: input.approvalId,
    action: 'status_change',
    before: { status: 'pending' },
    after: { status: input.verdict, note: input.note?.trim() || null, expiresAt },
  });

  const [client, decider] = await Promise.all([
    db.query.clients.findFirst({ where: eq(clients.id, row.clientId) }),
    db.query.users.findFirst({ where: eq(users.id, ctx.actorId) }),
  ]);
  await emitEvent(db, {
    type: 'DebtApprovalDecided',
    payload: {
      approvalId: input.approvalId,
      verdict: input.verdict,
      clientId: row.clientId,
      clientCode: client?.clientCode ?? '',
      clientName: client?.name ?? '',
      requestedBy: row.requestedBy,
      decidedByName: decider?.fullName ?? '',
      note: input.note?.trim() || null,
    },
    entityType: 'issue_approval',
    entityId: input.approvalId,
    actorId: ctx.actorId,
  });
}

/**
 * Find and LOCK a live approval for this issue. FOR UPDATE, so two phones
 * cannot spend one permission; the amount bound refuses a debt that GREW
 * past the approved snapshot — that is a different debt, and the person who
 * approved $100 never saw $150. Two steps (lock here, consume after the
 * handover row exists) because the consumed row carries an FK to the
 * handover — inside one transaction the pair is still atomic.
 */
export async function lockLiveApproval(
  tx: Tx,
  input: { clientId: string; warehouseId: string; blockingDebtUsd: number },
): Promise<string | null> {
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT id FROM issue_approvals
    WHERE client_id = ${input.clientId}
      AND warehouse_id = ${input.warehouseId}
      AND status = 'approved'
      AND expires_at > now()
      AND blocking_debt_usd >= ${input.blockingDebtUsd} - 0.009
    ORDER BY decided_at DESC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `);
  return rows[0]?.id ?? null;
}

/** The second half: the locked approval is spent on this handover. */
export async function markApprovalConsumed(
  tx: Tx,
  approvalId: string,
  handoverId: string,
): Promise<void> {
  await tx
    .update(issueApprovals)
    .set({ status: 'consumed', consumedHandoverId: handoverId, consumedAt: new Date() })
    .where(eq(issueApprovals.id, approvalId));
}

/** The pair's live approval state, for the issue screen's banner. */
export async function approvalStateFor(
  clientId: string,
  warehouseId: string,
): Promise<{ id: string; status: string; expiresAt: Date | null; blockingDebtUsd: number } | null> {
  const [row] = await db
    .select()
    .from(issueApprovals)
    .where(
      and(
        eq(issueApprovals.clientId, clientId),
        eq(issueApprovals.warehouseId, warehouseId),
        sql`${issueApprovals.status} IN ('pending', 'approved')`,
      ),
    )
    .orderBy(desc(issueApprovals.requestedAt))
    .limit(1);
  if (!row) return null;
  if (row.status === 'approved' && (!row.expiresAt || row.expiresAt.getTime() <= Date.now())) {
    return null; // lapsed unused — the screen offers a fresh request
  }
  return {
    id: row.id,
    status: row.status,
    expiresAt: row.expiresAt,
    blockingDebtUsd: Number(row.blockingDebtUsd),
  };
}

/** Everything a decider needs to answer from one small screen. */
export async function pendingApprovals() {
  return db
    .select({
      id: issueApprovals.id,
      requestedAt: issueApprovals.requestedAt,
      requestNote: issueApprovals.requestNote,
      blockingDebtUsd: issueApprovals.blockingDebtUsd,
      clientId: issueApprovals.clientId,
      clientCode: clients.clientCode,
      clientName: clients.name,
      warehouseCode: warehouses.code,
      requestedByName: users.fullName,
    })
    .from(issueApprovals)
    .innerJoin(clients, eq(issueApprovals.clientId, clients.id))
    .innerJoin(warehouses, eq(issueApprovals.warehouseId, warehouses.id))
    .innerJoin(users, eq(issueApprovals.requestedBy, users.id))
    .where(eq(issueApprovals.status, 'pending'))
    .orderBy(desc(issueApprovals.requestedAt));
}
