import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db, type Tx } from '../../platform/db/client';
import { clients, issueApprovals, users, warehouses } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';
import { usersWithPermission } from '../../platform/notifications/service';
import { getSetting } from '../../platform/settings/service';
import { clientBalanceUsd, deferredBalanceUsd } from '../finance/service';
import { SEES_ALL_MONEY_GRANTS } from '../finance/scope';
import { gatedAt, uncoveredBoxesOn, unpricedGate, unpricedReceiptsOn } from '../finance/unpriced';
import type { ApprovalQuestion } from './approval-covers';
import { ISSUABLE_STATUSES } from './parties';

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
 *
 * 0104 (the owner's Q3b) gives the same row a SECOND question: cartons with no
 * price («ruxsat berilmasa olib ketolmasin»), decided by the same people the
 * same way — «xuddi qarzdagidek». One row asks both, because the operator
 * presses one button and the decider reads one message; `unpriced_box_ids` is
 * the snapshot of cartons the decider was shown, like the debt's ceiling.
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

/**
 * The cartons at this counter that the ban stops right now: uncovered,
 * landed by road after the gate instant, issuable, standing HERE. The same
 * fragment and the same `gatedAt` the gate itself asks (#513).
 */
async function gatedHere(clientId: string, warehouseId: string): Promise<{ boxId: string; receiptId: string }[]> {
  const gate = await unpricedGate();
  const issuable: readonly string[] = ISSUABLE_STATUSES;
  return (await uncoveredBoxesOn(db, { kind: 'client', clientId }, { landedOnly: true }))
    .filter(
      (box) =>
        box.warehouseId === warehouseId && issuable.includes(box.status) && gatedAt(box.roadLandedAt, gate),
    )
    .map((box) => ({ boxId: box.boxId, receiptId: box.receiptId }));
}

/**
 * Who is pinged about a request (the owner lens of the 0104 design): every
 * `finance.debt_override` holder, MINUS the sellers of other clients.
 *
 * A seller is a holder whose money view is their own book — `finance.view`
 * and none of `SEES_ALL_MONEY_GRANTS`, the list `seesAllMoney` itself asks —
 * and round 91 already decided a seller reads only their own clients' money.
 * The request carries a debt figure and names a client, so pinging every
 * seller about every client was that hole reaching Telegram. The client's own
 * seller stays in. WHO MAY DECIDE is unchanged: the bot and /approvals still
 * ask only the grant.
 */
export async function approvalRecipients(clientId: string): Promise<string[]> {
  const [holders, viewers, wide, client] = await Promise.all([
    usersWithPermission('finance.debt_override'),
    usersWithPermission('finance.view'),
    Promise.all(SEES_ALL_MONEY_GRANTS.map((code) => usersWithPermission(code))),
    db.query.clients.findFirst({ where: eq(clients.id, clientId), columns: { salesManagerId: true } }),
  ]);
  const viewer = new Set(viewers);
  const seesAll = new Set(wide.flat());
  return holders.filter((id) => !(viewer.has(id) && !seesAll.has(id)) || id === client?.salesManagerId);
}

export async function requestIssueApproval(
  input: { clientId: string; warehouseId: string; note?: string },
  ctx: AuditContext,
): Promise<{ id: string }> {
  if (!ctx.actorId) throw new ApprovalError('unauthenticated');
  const [debt, gated] = await Promise.all([
    blockingDebtUsd(input.clientId),
    gatedHere(input.clientId, input.warehouseId),
  ]);
  // Nothing to approve — the gate is already open on both questions.
  if (debt <= 0.009 && gated.length === 0) throw new ApprovalError('nothing_to_approve');
  const question: ApprovalQuestion = {
    debtUsd: debt > 0.009 ? debt : null,
    boxIds: gated.map((box) => box.boxId),
  };

  // One live QUESTION per (client, warehouse): a second pending row would
  // only split the deciders' attention across duplicates.
  const [pending] = await db
    .select({ id: issueApprovals.id })
    .from(issueApprovals)
    .where(
      and(
        eq(issueApprovals.clientId, input.clientId),
        eq(issueApprovals.warehouseId, input.warehouseId),
        eq(issueApprovals.status, 'pending'),
      ),
    )
    .limit(1);
  if (pending) throw new ApprovalError('already_requested');
  // «Already approved» only when a live approval COVERS today's question.
  // Refusing on ANY live approval was a dead end: a debt that grew past the
  // snapshot (or a carton that landed after it) is refused at the gate, and
  // the operator could not ask again until the stale row expired.
  const covering = await db.execute<{ id: string }>(sql`
    SELECT id FROM issue_approvals
     WHERE client_id = ${input.clientId} AND warehouse_id = ${input.warehouseId}
       AND ${approvalCoversSql(question)}
     LIMIT 1
  `);
  if (covering[0]) throw new ApprovalError('already_approved');

  const reasons: 'debt' | 'price' | 'both' =
    question.debtUsd !== null && question.boxIds.length > 0
      ? 'both'
      : question.debtUsd !== null
        ? 'debt'
        : 'price';
  const receiptIds = [...new Set(gated.map((box) => box.receiptId))];

  const [row] = await db
    .insert(issueApprovals)
    .values({
      clientId: input.clientId,
      warehouseId: input.warehouseId,
      // A price-only request stores 0 — never the client's negative ADVANCE,
      // which would read as money on /approvals and pull the dashboard's
      // «debt awaiting approval» sum down. The gate asks the debt clause only
      // when it needs a debt, and `0 >= debt − 0.009` is false there.
      blockingDebtUsd: String(Math.max(debt, 0)),
      unpricedBoxIds: question.boxIds,
      requestedBy: ctx.actorId,
      requestNote: input.note?.trim() || null,
    })
    .returning({ id: issueApprovals.id });

  await writeAudit(db, { ...ctx, warehouseId: input.warehouseId }, {
    entityType: 'issue_approval',
    entityId: row!.id,
    action: 'create',
    after: {
      clientId: input.clientId,
      blockingDebtUsd: Math.max(debt, 0),
      ...(receiptIds.length ? { unpriced: { receiptIds, boxes: question.boxIds.length } } : {}),
    },
  });

  const [client, wh, requester, recipientIds, labels] = await Promise.all([
    db.query.clients.findFirst({ where: eq(clients.id, input.clientId) }),
    db.query.warehouses.findFirst({ where: eq(warehouses.id, input.warehouseId) }),
    db.query.users.findFirst({ where: eq(users.id, ctx.actorId) }),
    approvalRecipients(input.clientId),
    receiptIds.length
      ? unpricedReceiptsOn(db, { kind: 'receipts', receiptIds }, { state: 'off' })
      : Promise.resolve([]),
  ]);
  const perReceipt = new Map<string, number>();
  for (const box of gated) perReceipt.set(box.receiptId, (perReceipt.get(box.receiptId) ?? 0) + 1);
  const unpriced = labels.slice(0, 5).map((r) => ({
    number: r.number ?? '—',
    trucks: r.arrivalTrucks.map((t) => t.code).join(', '),
    boxes: perReceipt.get(r.receiptId) ?? r.boxes,
  }));
  await emitEvent(db, {
    type: 'DebtApprovalRequested',
    payload: {
      approvalId: row!.id,
      clientId: input.clientId,
      clientCode: client?.clientCode ?? '',
      clientName: client?.name ?? '',
      warehouseCode: wh?.code ?? '',
      blockingDebtUsd: Math.max(debt, 0),
      requestedByName: requester?.fullName ?? '',
      note: input.note?.trim() || null,
      // 0104: which question(s) this is, the cartons with no price by prixod,
      // and who is told (the platform reads `recipientIds` when present — it
      // must not import the money rule to compute it itself).
      reasons,
      unpriced,
      unpricedMore: Math.max(0, labels.length - unpriced.length),
      recipientIds,
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
      // The answer names the question it answers (0104): a price-only
      // permission must not read «qarzdorga berish».
      reasons:
        Number(row.blockingDebtUsd) > 0.009 && (row.unpricedBoxIds ?? []).length > 0
          ? 'both'
          : (row.unpricedBoxIds ?? []).length > 0
            ? 'price'
            : 'debt',
      decidedByName: decider?.fullName ?? '',
      note: input.note?.trim() || null,
    },
    entityType: 'issue_approval',
    entityId: input.approvalId,
    actorId: ctx.actorId,
  });
}

/**
 * The SQL twin of `approvalCovers` (approval-covers.ts) — ONE builder for
 * every SQL caller, so the gate's lock and the request's «already approved»
 * ask the same thing the screen asks. The box list is bound as ONE JSON
 * string cast to jsonb (a JS array bound into raw sql is not a postgres
 * array), and `@>` is containment: every asked carton was in the snapshot.
 */
export function approvalCoversSql(q: ApprovalQuestion): SQL {
  const debt = q.debtUsd === null ? sql`` : sql`AND blocking_debt_usd >= ${q.debtUsd} - 0.009`;
  const boxes = q.boxIds.length ? sql`AND unpriced_box_ids @> ${JSON.stringify(q.boxIds)}::jsonb` : sql``;
  return sql`(status = 'approved' AND expires_at > now() ${debt} ${boxes})`;
}

/**
 * Find and LOCK a live approval that covers this issue. FOR UPDATE, so two
 * phones cannot spend one permission; the debt bound refuses a debt that GREW
 * past the approved snapshot — that is a different debt, and the person who
 * approved $100 never saw $150 — and the box bound refuses a carton the
 * decider was never shown (0104). Two steps (lock here, consume after the
 * handover row exists) because the consumed row carries an FK to the
 * handover — inside one transaction the pair is still atomic.
 */
export async function lockLiveApproval(
  tx: Tx,
  input: { clientId: string; warehouseId: string; question: ApprovalQuestion },
): Promise<string | null> {
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT id FROM issue_approvals
    WHERE client_id = ${input.clientId}
      AND warehouse_id = ${input.warehouseId}
      AND ${approvalCoversSql(input.question)}
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

/**
 * The pair's live approval state, for the issue screen's banner. The newest
 * live row, as it always was, now with its carton snapshot — the SCREEN
 * decides whether it covers the selected boxes (`approvalCovers`), so an
 * approval that does not says «yangidan so'rang» instead of «ruxsat berildi».
 */
export async function approvalStateFor(
  clientId: string,
  warehouseId: string,
): Promise<{
  id: string;
  status: string;
  expiresAt: Date | null;
  blockingDebtUsd: number;
  unpricedBoxIds: string[];
} | null> {
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
    unpricedBoxIds: row.unpricedBoxIds ?? [],
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
      unpricedBoxIds: issueApprovals.unpricedBoxIds,
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

export interface ApprovalUnpricedLine {
  receiptId: string;
  number: string | null;
  /** The trucks whose landing brought the still-uncovered cartons in — the pricing door. */
  arrivalTrucks: { batchId: string; code: string }[];
  /** Cartons of the snapshot that still have no price. 0 = priced meanwhile. */
  stillBoxes: number;
  snapshotBoxes: number;
}

/**
 * The price half of each pending request, as /approvals prints it: the
 * snapshot's prixods, how many of their cartons are STILL uncovered, and
 * where to price them. ONE read over every pending row's cartons (#432) —
 * the same fragment the gate asks, so «✅ narx qo'yildi» here means the
 * counter will let that carton go without this approval.
 */
export async function approvalUnpricedDetail(
  rows: { id: string; unpricedBoxIds: string[] | null }[],
): Promise<Map<string, ApprovalUnpricedLine[]>> {
  const out = new Map<string, ApprovalUnpricedLine[]>();
  const allIds = [...new Set(rows.flatMap((row) => row.unpricedBoxIds ?? []))];
  if (allIds.length === 0) return out;
  const idList = sql.join(
    allIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const [owners, still] = await Promise.all([
    db.execute<{ box_id: string; receipt_id: string; number: string | null }>(sql`
      SELECT b.id AS box_id, r.id AS receipt_id, r.number
        FROM boxes b JOIN receipt_lots rl ON rl.id = b.lot_id JOIN receipts r ON r.id = rl.receipt_id
       WHERE b.id IN (${idList})
    `),
    uncoveredBoxesOn(db, { kind: 'boxes', boxIds: allIds }, { landedOnly: true }),
  ]);
  const stillIds = new Set(still.map((box) => box.boxId));
  const receiptOf = new Map(owners.map((row) => [row.box_id, row]));
  const openReceipts = [...new Set(still.map((box) => box.receiptId))];
  const trucks = new Map(
    (openReceipts.length
      ? await unpricedReceiptsOn(db, { kind: 'receipts', receiptIds: openReceipts }, { state: 'off' })
      : []
    ).map((row) => [row.receiptId, row.arrivalTrucks]),
  );
  for (const row of rows) {
    const lines = new Map<string, ApprovalUnpricedLine>();
    for (const boxId of row.unpricedBoxIds ?? []) {
      const owner = receiptOf.get(boxId);
      if (!owner) continue;
      const line = lines.get(owner.receipt_id) ?? {
        receiptId: owner.receipt_id,
        number: owner.number,
        arrivalTrucks: trucks.get(owner.receipt_id) ?? [],
        stillBoxes: 0,
        snapshotBoxes: 0,
      };
      line.snapshotBoxes += 1;
      if (stillIds.has(boxId)) line.stillBoxes += 1;
      lines.set(owner.receipt_id, line);
    }
    if (lines.size) out.set(row.id, [...lines.values()]);
  }
  return out;
}
