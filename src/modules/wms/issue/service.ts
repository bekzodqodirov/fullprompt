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
import { usersWithPermission, usersWithRoles } from '../../platform/notifications/service';
import { blockingDebtOf, clientBalanceUsd, debtBlocks, deferredDealsUsd } from '../finance/service';
import { counterDebtRelease, mayOverridePrice, type DebtReleaser } from '../finance/scope';
import { deferralCover, deferredTotal } from '../debt/rules';
import { gatedAt, uncoveredBoxesOn, unpricedGate, unpricedReceiptsOn, type UncoveredBox } from '../finance/unpriced';
import { claimIssuedNotice } from '../notices/client-claims';
import { lockLiveApproval, markApprovalConsumed } from './approvals';
import { DEBT_RELEASED_GRANT_CODES, debtReleasedText, receivesDebtReleased } from './debt-release';

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
   * The price half of the same tick (0104, the owner's Q3b): a person who may
   * let this client's cargo go on debt (`mayGrantDebt`) allows cargo with no
   * price to go out — «xuddi qarzdagidek», so the same predicate, asked in
   * the service like `debtOk` (0114).
   */
  priceOk: z.boolean().default(false),
  note: z.string().trim().max(500).optional().or(z.literal('')),
  /**
   * WHY the debt tick lets this cargo go (0126, the owner's D4a) — mandatory
   * for EVERYBODY whose tick is used over a real debt, refused as
   * `debt_note_required` below. Never on the act: `note` above prints there
   * and a driver often signs it; this one is stored in `handovers.debt_note`.
   */
  debtNote: z.string().trim().max(500).optional().or(z.literal('')),
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
export async function issueBoxes(request: IssueRequest, ctx: AuditContext, releaser: DebtReleaser) {
  if (!ctx.actorId) throw new IssueError('unauthenticated');
  const input: IssueInput = { ...request, priceOk: request.priceOk ?? false };
  const actorId = ctx.actorId;
  // Debt gate (Phase 2.1, owner's rule): a debtor gets cargo only with a
  // manager's permission — debtOk is that permission. Since 0114 (the owner's
  // 2a) WHOSE permission is the service's question and not the action's: the
  // releaser must be allowed to release THIS client's debt HERE
  // (`counterDebtRelease` — `mayGrantDebt`'s seller-own / admin-and-accountant-
  // everybody's, plus since D2 (2026-10-07) the warehouse manager at his own
  // warehouse), and `releaser` is REQUIRED because an optional one fails open
  // (#790).
  // Money the client agreed to pay LATER, on a job that is still waiting for
  // its last box, is not overdue (docs/DEALS.md answer 4). The client's
  // displayed balance stays honest — only the figure the GATE reads is
  // reduced, and only by charges raised on a deal that is deferred right now.
  // All read on the POOL before the transaction opens (#714): the balance,
  // the deferrals job by job (0114 stores who granted them), the ban's
  // instant (a setting) and whose client this is.
  const [balance, deferredDeals, gate, owner] = await Promise.all([
    clientBalanceUsd(input.clientId),
    deferredDealsUsd(input.clientId),
    unpricedGate(),
    db.query.clients.findFirst({ where: eq(clients.id, input.clientId), columns: { salesManagerId: true } }),
  ]);
  // `deferredBalanceUsd`'s own arithmetic on the same list — one function,
  // so the counter screen and this gate cannot drift by a cent.
  const deferred = deferredTotal(deferredDeals);
  const blockingDebt = blockingDebtOf(balance, deferred);
  const release = counterDebtRelease(releaser, { salesManagerId: owner?.salesManagerId ?? null }, input.warehouseId);
  const mayGrant = release !== null;
  // The tick is USED only over a real debt (the judge's #16): a stale box over
  // a balance a payment cleared opens nothing — it needs no comment, stores
  // none, and tells nobody.
  const debtTickUsed = debtBlocks(balance, deferred) && input.debtOk;
  const debtNote = (input.debtNote ?? '').trim();
  // Which «muddat» let how much of this balance through, and whose it was.
  const covered = deferralCover(balance, deferredDeals);
  const result = await db.transaction(async (tx) => {
    const existing = await tx.query.handovers.findFirst({
      where: eq(handovers.id, input.handoverId),
    });
    // A replay is NEVER refused: the handover it names already happened, and
    // the phone asking again must get the act back, whatever changed since.
    if (existing) {
      return {
        handover: existing,
        gated: [] as UncoveredBox[],
        replay: true,
        approvalId: null as string | null,
        debtOpened: null as 'tick' | 'approval' | null,
      };
    }

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

    // A tick is refused only when it is USED (the judge's #16): the screen's
    // box posted over a debt that a payment cleared meanwhile opens nothing,
    // and refusing it would stop a legitimate handover for a stale checkbox.
    // After the replay return — a replay is never refused.
    if (debtBlocks(balance, deferred) && input.debtOk && !mayGrant) throw new IssueError('debt_override_forbidden');
    // D4a: whoever ticks writes WHY — the seller, the accountant, the admin and
    // the warehouse manager alike. Asked after the right (a person who may not
    // tick hears that first, not «write a reason»), refused only when the tick
    // is USED, like the right above.
    if (debtTickUsed && !debtNote) throw new IssueError('debt_note_required');
    if (gated.length > 0 && input.priceOk && !mayOverridePrice(releaser)) throw new IssueError('price_override_forbidden');

    // Phase 6 + 0104: an operator without the tick may still issue when a
    // RECORDED approval covers the question — live, unexpired, at least as
    // large as today's debt, and naming every gated carton. Locked here (FOR
    // UPDATE, so two phones cannot spend one permission) and marked consumed
    // once the handover row exists; one transaction makes the pair atomic.
    // A deferral (#207) excuses a DEBT and never a missing price.
    const needDebt = debtBlocks(balance, deferred) && !input.debtOk;
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
        // What the gate saw (0114) — the figures read above, stored, never
        // recomputed: the register lists a release on debt from these.
        owedUsd: balance.toFixed(2),
        blockingUsd: blockingDebt.toFixed(2),
        deferredUsd: deferred.toFixed(2),
        deferrals: covered.length > 0 ? covered : null,
        note: input.note || null,
        // D4a's comment, only when the tick opened the gate (the CHECK pairs it
        // with debt_ok); never on the act — that is `note` above.
        debtNote: debtTickUsed ? debtNote : null,
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
        // The debt the cargo left under (0114), when there was one.
        ...(balance > 0.009 ? { debt: { owedUsd: balance, blockingUsd: blockingDebt, deferredUsd: deferred } } : {}),
        // Cargo with no price that went out anyway, by prixod — the money
        // most at risk, on the record beside the permission that let it.
        ...(gated.length
          ? { unpriced: { receiptIds: [...new Set(gated.map((box) => box.receiptId))], boxes: gated.length } }
          : {}),
        // Both halves of a debtor issue are in the log: the decision on the
        // approval row, and here WHICH approval this handover spent.
        ...(approvalId ? { approvalId } : {}),
        // The tick's comment and WHY it was this person's (D2/D4a).
        ...(debtTickUsed ? { debtNote, debtRight: release } : {}),
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
    // The customer's «yukingiz berildi» (round C): a claimed notice in this
    // transaction, sent by the notices sweep — no longer rendered by the event
    // drain from the payload above, which stays for the staff side, the deal
    // funnel and the automation rules.
    await claimIssuedNotice(tx, input.clientId, handover!.id);
    // Who opened the DEBT gate at this press, if anybody: the tick, or an
    // approval spent while the debt was the question. A release excused only
    // by a deal «muddat» is neither — nobody pressed anything (stated).
    const debtOpened: 'tick' | 'approval' | null = debtTickUsed ? 'tick' : approvalId && needDebt ? 'approval' : null;
    return { handover: handover!, gated, replay: false, approvalId, debtOpened };
  });
  // AFTER the commit — a Telegram row must never be able to roll a handover
  // back — and only when cargo with no price actually went out, by a tick or
  // an approval: that is the moment the money is most at risk.
  if (!result.replay && result.gated.length > 0) {
    await notifyUnpricedIssued(result.handover.id, input, result.gated, ctx.actorId, result.approvalId).catch(() => {});
  }
  // D6a: the owner and the accountant hear every release on debt. NEVER a
  // silent catch — this message is the control that replaced the request the
  // owner took away in D2, so a fault in it must leave a line in the logs.
  // The release itself is committed and stays.
  if (!result.replay && result.debtOpened) {
    await notifyDebtReleased({
      handoverId: result.handover.id,
      input,
      how: result.debtOpened,
      right: release,
      approvalId: result.approvalId,
      blockingUsd: blockingDebt,
      deferredUsd: deferred,
      actorId,
    }).catch((err) => console.error('[debt-released]', result.handover.id, err));
  }
  return result.handover;
}

/**
 * Who hears «qarzga yuk berildi» — the audience ROLES with the company's
 * money sight, `receivesDebtReleased` asked of each candidate with exactly
 * the grants it reads, rebuilt from the editable grants (the
 * `approvalRecipients` idiom). Deactivated and no-login people are already
 * out of both lists.
 */
export async function debtReleasedAudience(): Promise<string[]> {
  const [owners, accountants, ...held] = await Promise.all([
    usersWithRoles(['super_admin']),
    usersWithRoles(['accountant']),
    ...DEBT_RELEASED_GRANT_CODES.map((code) => usersWithPermission(code)),
  ]);
  const roles = new Map<string, string[]>();
  for (const id of owners!) roles.set(id, [...(roles.get(id) ?? []), 'super_admin']);
  for (const id of accountants!) roles.set(id, [...(roles.get(id) ?? []), 'accountant']);
  const grants = new Map<string, Set<string>>();
  DEBT_RELEASED_GRANT_CODES.forEach((code, i) => {
    for (const id of held[i]!) grants.set(id, (grants.get(id) ?? new Set()).add(code));
  });
  return [...roles.entries()]
    .filter(([id, roleCodes]) =>
      receivesDebtReleased({ id, permissions: grants.get(id) ?? new Set(), roles: roleCodes }),
    )
    .map(([id]) => id);
}

/**
 * «🔓 Qarzga yuk berildi» (D6a) — after the commit. The figures are the
 * gate's own (what was stored on the handover); for an approval the reason is
 * the REQUEST's (D5a made it mandatory) and the decider is left out of the
 * list — he made the decision himself; the presser goes as `exceptUserId`.
 */
async function notifyDebtReleased(release: {
  handoverId: string;
  input: IssueInput;
  how: 'tick' | 'approval';
  right: 'ledger' | 'warehouse' | null;
  approvalId: string | null;
  blockingUsd: number;
  deferredUsd: number;
  actorId: string;
}): Promise<void> {
  const [audience, client, wh, actor, approval] = await Promise.all([
    debtReleasedAudience(),
    db.query.clients.findFirst({ where: eq(clients.id, release.input.clientId) }),
    db.query.warehouses.findFirst({ where: eq(warehouses.id, release.input.warehouseId) }),
    db.query.users.findFirst({ where: eq(users.id, release.actorId) }),
    release.how === 'approval' && release.approvalId
      ? db
          .execute<{
            request_note: string | null;
            decision_note: string | null;
            decided_by: string | null;
            decider: string | null;
          }>(sql`
            SELECT a.request_note, a.decision_note, a.decided_by, u.full_name AS decider
              FROM issue_approvals a LEFT JOIN users u ON u.id = a.decided_by
             WHERE a.id = ${release.approvalId}::uuid`)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
  ]);
  const userIds = audience.filter((id) => id !== approval?.decided_by);
  if (userIds.length === 0) return;
  const text = debtReleasedText({
    clientCode: client?.clientCode ?? '',
    clientName: client?.name ?? '',
    warehouseCode: wh?.code ?? '',
    boxes: release.input.boxIds.length,
    blockingUsd: release.blockingUsd,
    deferredUsd: release.deferredUsd,
    how: release.how,
    right: release.how === 'tick' ? release.right : null,
    actorName: actor?.fullName ?? '—',
    deciderName: approval?.decider ?? null,
    note: release.how === 'tick' ? (release.input.debtNote ?? '').trim() || null : (approval?.request_note ?? null),
    decisionNote: approval?.decision_note ?? null,
    appUrl: process.env.APP_URL ?? '',
  });
  await notifyStaffTelegram({
    userIds,
    type: 'DebtReleased',
    exceptUserId: release.actorId,
    text,
    extra: { handoverId: release.handoverId },
  });
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
