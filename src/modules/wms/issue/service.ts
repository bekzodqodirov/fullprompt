import { and, eq, inArray, sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  boxes,
  boxMovements,
  clients,
  handovers,
  receiptLots,
  receipts,
  scanEvents,
  users,
  warehouses,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { usersWithPermission } from '../../platform/notifications/service';
import { clientBalanceUsd, deferredBalanceUsd } from '../finance/service';
import { gatedAt, uncoveredBoxesOn, unpricedGate, unpricedReceiptsOn, type UncoveredBox } from '../finance/unpriced';
import { lockLiveApproval, markApprovalConsumed } from './approvals';

export class IssueError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export const issueSchema = z.object({
  /** Client-generated: idempotency + photo pre-binding + act URL. */
  handoverId: z.string().uuid(),
  clientId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  boxIds: z.array(z.string().uuid()).min(1).max(500),
  personName: z.string().trim().min(2).max(200),
  personPhone: z.string().trim().min(5).max(50),
  /** Debt gate override (Phase 2.1): a permitted manager allows issuing to a debtor. */
  debtOk: z.boolean().default(false),
  /**
   * The price half of the same tick (0104, the owner's Q3b): a
   * `finance.debt_override` holder at the counter allows cargo with no price
   * to go out. Checked against the permission in the action layer, like
   * `debtOk`.
   */
  priceOk: z.boolean().default(false),
  note: z.string().trim().max(500).optional().or(z.literal('')),
});
export type IssueInput = z.infer<typeof issueSchema>;
/**
 * What a caller hands `issueBoxes`: the tick may be left out, and absent means
 * «no tick» — the doors and fixtures that never raised the price question keep
 * their shape, and none of them can pass the ban by omission.
 */
export type IssueRequest = Omit<IssueInput, 'priceOk'> & { priceOk?: boolean };

/**
 * W7 issue-to-client (spec 6.7): selected boxes → `issued` with a handover
 * record; partial pickup simply leaves the rest ready_for_pickup. Idempotent
 * by handoverId.
 *
 * TWO gates, one permission record (0104). The debt gate (Phase 2.1) and the
 * price gate — the owner's Q3b, «ruxsat berilmasa olib ketolmasin, taqiq
 * tursin»: a selected carton that has no price (`finance/unpriced.ts`, the
 * one rule the accountant's list and the dashboard also read), landed by one
 * of our trucks after the ban's instant, goes out only with a holder's tick
 * (`priceOk`) or a live approval whose snapshot names it. This is the ONLY
 * door that writes `issued_to_client` (a wire test pins it), so the ban lives
 * in the service and not on the screen (#531).
 */
export async function issueBoxes(request: IssueRequest, ctx: AuditContext) {
  if (!ctx.actorId) throw new IssueError('unauthenticated');
  const input: IssueInput = { ...request, priceOk: request.priceOk ?? false };
  const actorId = ctx.actorId;
  // Debt gate (Phase 2.1, owner's rule): a debtor gets cargo only with a
  // manager's permission — debtOk is that permission, checked in the action
  // layer against finance.debt_override.
  // Money the client agreed to pay LATER, on a job that is still waiting for
  // its last box, is not overdue (docs/DEALS.md answer 4). The client's
  // displayed balance stays honest — only the figure the GATE reads is
  // reduced, and only by charges raised on a deal that is deferred right now.
  // Both read on the POOL before the transaction opens (#714): the balance,
  // and the ban's instant (a setting).
  const [balance, deferred, gate] = await Promise.all([
    clientBalanceUsd(input.clientId),
    deferredBalanceUsd(input.clientId),
    unpricedGate(),
  ]);
  const blockingDebt = Math.round((balance - deferred) * 100) / 100;
  const result = await db.transaction(async (tx) => {
    const existing = await tx.query.handovers.findFirst({
      where: eq(handovers.id, input.handoverId),
    });
    // A replay is NEVER refused: the handover it names already happened, and
    // the phone asking again must get the act back, whatever changed since.
    if (existing) return { handover: existing, gated: [] as UncoveredBox[], replay: true, approvalId: null as string | null };

    // The box lock and its validation come FIRST (they used to follow the
    // approval lock): the price question is asked about these validated
    // boxes. Its refusals and their words are unchanged — a request with a
    // bad box AND a debt now says box_not_found first.
    const rows = await tx
      .select({ box: boxes, clientId: receipts.clientId })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .where(inArray(boxes.id, input.boxIds))
      .for('update', { of: boxes });
    if (rows.length !== input.boxIds.length) throw new IssueError('box_not_found');
    for (const { box, clientId } of rows) {
      if (clientId !== input.clientId) throw new IssueError('wrong_client');
      if (!['ready_for_pickup', 'in_stock'].includes(box.status)) {
        throw new IssueError('box_not_available');
      }
      if (box.currentWarehouseId !== input.warehouseId) throw new IssueError('box_wrong_warehouse');
    }

    // The price question, on THIS transaction's connection. A walk-in
    // (received straight into this warehouse) and cargo that never landed in
    // Uzbekistan are not gated — that follows from `gatedAt`, not from an
    // exception here.
    const gated = (await uncoveredBoxesOn(tx, { kind: 'boxes', boxIds: input.boxIds }, { landedOnly: true })).filter(
      (box) => gatedAt(box.roadLandedAt, gate),
    );

    // Phase 6 + 0104: an operator without the tick may still issue when a
    // RECORDED approval covers the question — live, unexpired, at least as
    // large as today's debt, and naming every gated carton. Locked here (FOR
    // UPDATE, so two phones cannot spend one permission) and marked consumed
    // once the handover row exists; one transaction makes the pair atomic.
    // A deferral (#207) excuses a DEBT and never a missing price.
    const needDebt = blockingDebt > 0.009 && !input.debtOk;
    const needPrice = gated.length > 0 && !input.priceOk;
    let approvalId: string | null = null;
    if (needDebt || needPrice) {
      approvalId = await lockLiveApproval(tx, {
        clientId: input.clientId,
        warehouseId: input.warehouseId,
        question: {
          debtUsd: needDebt ? blockingDebt : null,
          boxIds: needPrice ? gated.map((box) => box.boxId) : [],
        },
      });
      if (!approvalId) {
        // «Its price sits on another truck» is a different sentence from «it
        // has no price»: the first is the accountant's one press away.
        const priceCode = gated.every((box) => box.elsewhere) ? 'price_elsewhere' : 'price_block';
        throw new IssueError(needDebt && needPrice ? 'debt_price_block' : needDebt ? 'debt_block' : priceCode);
      }
    }

    const [handover] = await tx
      .insert(handovers)
      .values({
        id: input.handoverId,
        clientId: input.clientId,
        warehouseId: input.warehouseId,
        kind: 'issued_to_client',
        personName: input.personName,
        personPhone: input.personPhone,
        debtOk: input.debtOk,
        priceOk: input.priceOk,
        note: input.note || null,
        createdBy: actorId,
      })
      .returning();

    if (approvalId) await markApprovalConsumed(tx, approvalId, handover!.id);

    await tx
      .update(boxes)
      .set({ status: 'issued', crateId: null, statusReason: 'issued_to_client' })
      .where(inArray(boxes.id, input.boxIds));
    await tx.insert(boxMovements).values(
      rows.map(({ box }) => ({
        boxId: box.id,
        fromWarehouseId: box.currentWarehouseId,
        toWarehouseId: box.currentWarehouseId,
        fromStatus: box.status,
        toStatus: 'issued',
        cause: 'issued',
        refType: 'handover',
        refId: handover!.id,
        actorId,
      })),
    );
    await tx.insert(scanEvents).values(
      rows.map(({ box }) => ({
        clientEventUuid: uuidv5(box.id, input.handoverId),
        boxId: box.id,
        handoverId: handover!.id,
        type: 'issue',
        method: 'manual',
        manualReason: 'issue_screen',
        scannedBy: actorId,
        scannedAt: new Date(),
      })),
    ).onConflictDoNothing();

    const wh = (await tx.query.warehouses.findFirst({
      where: eq(warehouses.id, input.warehouseId),
    }))!;
    // What was HANDED, by goods. The payload feeds the client's Telegram
    // message, and «yukingiz berildi» with a bare box count was the owner's
    // complaint — the client wants the goods, the kilos and the cubes on the
    // record they screenshot. Weight and volume are a SHARE of the lot,
    // exactly as the arrival notice computes them: a box carries no weight of
    // its own, the lot does, so three boxes of a twenty-box lot are three
    // twentieths of its kilos.
    const issuedRows = await tx
      .select({
        letter: receiptLots.letter,
        nameRu: receiptLots.productNameRu,
        nameZh: receiptLots.productNameZh,
        lotBoxes: receiptLots.boxCount,
        lotKg: receiptLots.totalWeightKg,
        lotM3: receiptLots.totalVolumeM3,
        issued: sql<number>`count(${boxes.id})`,
      })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .where(inArray(boxes.id, input.boxIds))
      .groupBy(
        receiptLots.id,
        receiptLots.letter,
        receiptLots.productNameRu,
        receiptLots.productNameZh,
        receiptLots.boxCount,
        receiptLots.totalWeightKg,
        receiptLots.totalVolumeM3,
      )
      .orderBy(receiptLots.letter);
    // The ArrivedLot wire shape, so the cabinet renderer draws a handover the
    // way it already draws an arrival.
    const issuedLots = issuedRows.map((row) => {
      const share = Number(row.lotBoxes) > 0 ? Number(row.issued) / Number(row.lotBoxes) : 0;
      return {
        letter: row.letter,
        productNameZh: row.nameZh,
        productNameRu: row.nameRu,
        boxCount: Number(row.issued),
        totalWeightKg: Number(row.lotKg ?? 0) * share,
        totalVolumeM3: Number(row.lotM3 ?? 0) * share,
      };
    });
    const remainingRow = await tx
      .select({ n: sql<number>`count(*)` })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .where(
        and(
          eq(receipts.clientId, input.clientId),
          eq(boxes.currentWarehouseId, input.warehouseId),
          inArray(boxes.status, ['ready_for_pickup', 'in_stock']),
        ),
      );

    await writeAudit(tx, { ...ctx, warehouseId: input.warehouseId }, {
      entityType: 'handover',
      entityId: handover!.id,
      action: 'create',
      after: {
        clientId: input.clientId,
        boxCount: rows.length,
        personName: input.personName,
        debtOk: input.debtOk,
        priceOk: input.priceOk,
        // Cargo with no price that went out anyway, by prixod — the money
        // most at risk, on the record beside the permission that let it.
        ...(gated.length
          ? { unpriced: { receiptIds: [...new Set(gated.map((box) => box.receiptId))], boxes: gated.length } }
          : {}),
        // Both halves of a debtor issue are in the log: the decision on the
        // approval row, and here WHICH approval this handover spent.
        ...(approvalId ? { approvalId } : {}),
      },
    });
    await emitEvent(tx, {
      type: 'BoxIssued',
      payload: {
        handoverId: handover!.id,
        clientId: input.clientId,
        warehouseId: input.warehouseId,
        warehouseCode: wh.code,
        boxCount: rows.length,
        lots: issuedLots,
        weightKg: issuedLots.reduce((sum, lot) => sum + lot.totalWeightKg, 0),
        volumeM3: issuedLots.reduce((sum, lot) => sum + lot.totalVolumeM3, 0),
        remaining: Number(remainingRow[0]!.n),
        personName: input.personName,
        personPhone: input.personPhone,
      },
      entityType: 'handover',
      entityId: handover!.id,
      actorId,
    });
    return { handover: handover!, gated, replay: false, approvalId };
  });
  // AFTER the commit — a Telegram row must never be able to roll a handover
  // back — and only when cargo with no price actually went out, by a tick or
  // an approval: that is the moment the money is most at risk.
  if (!result.replay && result.gated.length > 0) {
    await notifyUnpricedIssued(result.handover.id, input, result.gated, ctx.actorId, result.approvalId).catch(() => {});
  }
  return result.handover;
}

/**
 * «💰 Narxsiz yuk berildi» to the people who price it — `finance.reports`
 * (the accountant and the admins; the VED holds none, which matches the
 * owner's Q19). Plain Uzbek, the sibling `notifyLoadSummary`'s convention.
 */
async function notifyUnpricedIssued(
  handoverId: string,
  input: IssueInput,
  gated: UncoveredBox[],
  actorId: string | null | undefined,
  approvalId: string | null,
): Promise<void> {
  const userIds = await usersWithPermission('finance.reports');
  if (userIds.length === 0) return;
  const receiptIds = [...new Set(gated.map((box) => box.receiptId))];
  const [labels, client, wh, actor] = await Promise.all([
    unpricedReceiptsOn(db, { kind: 'receipts', receiptIds }, { state: 'off' }),
    db.query.clients.findFirst({ where: eq(clients.id, input.clientId) }),
    db.query.warehouses.findFirst({ where: eq(warehouses.id, input.warehouseId) }),
    actorId ? db.query.users.findFirst({ where: eq(users.id, actorId) }) : null,
  ]);
  // «Ruxsat» names who ALLOWED it (review): on a tick that is the presser,
  // on an approval it is the person who decided the request — the operator
  // at the counter only carried it out.
  const decider = approvalId
    ? (
        await db.execute<{ full_name: string | null }>(sql`
          SELECT u.full_name FROM issue_approvals a JOIN users u ON u.id = a.decided_by WHERE a.id = ${approvalId}::uuid`)
      )[0]?.full_name ?? null
    : null;
  const perReceipt = new Map<string, number>();
  for (const box of gated) perReceipt.set(box.receiptId, (perReceipt.get(box.receiptId) ?? 0) + 1);
  const numberOf = new Map(labels.map((r) => [r.receiptId, r]));
  const lines = receiptIds.slice(0, 8).map((id) => {
    const r = numberOf.get(id);
    const trucks = r?.arrivalTrucks.map((t) => t.code).join(', ');
    return `${perReceipt.get(id)} karobka · prixod ${r?.number ?? '—'}${trucks ? ` (${trucks})` : ''}`;
  });
  const appUrl = process.env.APP_URL ?? '';
  await notifyStaffTelegram({
    userIds,
    type: 'UnpricedIssued',
    exceptUserId: actorId ?? null,
    text:
      `💰 Narxsiz yuk berildi — ${client?.clientCode ?? ''} · ${wh?.code ?? ''}\n` +
      lines.join('\n') +
      (receiptIds.length > lines.length ? `\n… +${receiptIds.length - lines.length}` : '') +
      (decider
        ? `\nRuxsat: ${decider} (so‘rov) · berdi: ${actor?.fullName ?? '—'}`
        : `\nRuxsat: ${actor?.fullName ?? '—'} (${input.priceOk ? 'belgi' : "so‘rov"})`) +
      `\n${appUrl}/finance/narxsiz`,
  });
}
