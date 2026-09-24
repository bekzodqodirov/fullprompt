import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  attachments,
  expenseRequests,
  users,
  userWarehouses,
  warehouses,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';
import { isUniqueViolation } from '../../platform/db/errors';

/**
 * Rasxod xabari (round 107, owner's item 5): «skladchi rasxodni o'zi
 * kirgazmasin — xabar bersin, moliya kirgazadi».
 *
 * The operator's fold on /receive writes a REQUEST — summa, izoh, chek
 * photos pre-bound to a client-minted id (#180's pattern) — and everyone
 * holding `finance.expenses` is pinged. Entering the real expense CLAIMS the
 * request first (`WHERE status='open'`, the round-106 drain's rule: the
 * double-entry race is the common case, the crash is not); a refusal of the
 * expense RELEASES it; voiding the expense later re-opens it, because a fold
 * reading «kiritildi» about money that was taken back is #528's one-way
 * pair rule.
 */

export class ExpenseRequestError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export const expenseRequestSchema = z.object({
  /** Client-minted: the chek photos are uploaded against it BEFORE the save. */
  id: z.string().uuid(),
  /**
   * Optional since 0101: a seller, the logist or the VED spends money too and
   * belongs to no warehouse, so their report (filed from /profile) names none.
   * The /receive door still demands one — it authorises AT the warehouse.
   */
  warehouseId: z.string().uuid().optional(),
  /**
   * «O'z pulimdan to'ladim» (owner M1a): the reporter paid out of pocket, so
   * the accountant's «Kiritish» books a debt to their staff account instead
   * of cash out of a kassa. This fold is the ONLY place a non-finance person
   * may say it — the cost and expense forms offer no such payer.
   */
  paidBySelf: z.boolean().optional(),
  amount: z.number().min(0.01).max(100_000_000),
  currency: z.string().length(3),
  note: z.string().trim().min(2).max(500),
});
export type ExpenseRequestInput = z.infer<typeof expenseRequestSchema>;

export async function requestExpense(input: ExpenseRequestInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new ExpenseRequestError('unauthenticated');
  // Names for the Telegram message, read BEFORE the transaction opens — the
  // pool is off-limits inside one (#714).
  const warehouseId = input.warehouseId ?? null;
  const [warehouse, requester] = await Promise.all([
    warehouseId
      ? db.query.warehouses.findFirst({ where: eq(warehouses.id, warehouseId) })
      : Promise.resolve(null),
    db.query.users.findFirst({ where: eq(users.id, ctx.actorId) }),
  ]);
  // Checked only when one was NAMED: no warehouse is an answer (a seller's
  // taxi), an unknown one is a forged post.
  if (warehouseId && !warehouse) throw new ExpenseRequestError('warehouse_not_found');
  const paidBySelf = input.paidBySelf ?? false;

  try {
    await db.transaction(async (tx) => {
      // The insert and the event share one transaction: a request nobody is
      // ever pinged about is a report that silently vanished.
      await tx.insert(expenseRequests).values({
        id: input.id,
        warehouseId,
        paidBySelf,
        amount: input.amount.toFixed(2),
        currency: input.currency.toUpperCase(),
        note: input.note,
        createdBy: ctx.actorId!,
      });
      await emitEvent(tx, {
        type: 'ExpenseRequested',
        payload: {
          requestId: input.id,
          requestedBy: ctx.actorId,
          requesterName: requester?.fullName ?? '',
          // Null, never '' or a placeholder: the Telegram text leaves the
          // warehouse out rather than printing «— null».
          warehouseCode: warehouse?.code ?? null,
          paidBySelf,
          amount: input.amount.toFixed(2),
          currency: input.currency.toUpperCase(),
          note: input.note,
        },
        entityType: 'expense_request',
        entityId: input.id,
        actorId: ctx.actorId,
      });
    });
  } catch (err) {
    // The id is the client's idempotency key — a double tap replays as the
    // same request, never as two (confirmReceipt's rule).
    if (isUniqueViolation(err)) return;
    throw err;
  }
  await writeAudit(db, { ...ctx, warehouseId }, {
    entityType: 'expense_request',
    entityId: input.id,
    action: 'create',
    after: { amount: input.amount, currency: input.currency, note: input.note, paidBySelf },
  });
}

/**
 * The decider's queue: open requests, oldest first — plus any claimed row
 * whose expense never landed (a crash between the claim and the save), which
 * must stay VISIBLE rather than silently re-enterable.
 */
export async function openExpenseRequests() {
  const rows = await db
    .select({
      id: expenseRequests.id,
      warehouseCode: warehouses.code,
      warehouseTimezone: warehouses.timezone,
      amount: expenseRequests.amount,
      currency: expenseRequests.currency,
      note: expenseRequests.note,
      status: expenseRequests.status,
      expenseId: expenseRequests.expenseId,
      warehouseId: expenseRequests.warehouseId,
      createdAt: expenseRequests.createdAt,
      createdBy: expenseRequests.createdBy,
      paidBySelf: expenseRequests.paidBySelf,
      requesterName: users.fullName,
    })
    .from(expenseRequests)
    // LEFT: a report filed from /profile names no warehouse (0101), and an
    // inner join would drop it from the only queue that can answer it — the
    // reporter's money gone silent with the fold still saying «⏳».
    .leftJoin(warehouses, eq(expenseRequests.warehouseId, warehouses.id))
    .innerJoin(users, eq(expenseRequests.createdBy, users.id))
    .where(
      or(
        eq(expenseRequests.status, 'open'),
        and(eq(expenseRequests.status, 'done'), isNull(expenseRequests.expenseId)),
      ),
    )
    .orderBy(expenseRequests.createdAt)
    .limit(100);
  const kept = rows;
  const photos = kept.length
    ? await db
        .select({ id: attachments.id, entityId: attachments.entityId })
        .from(attachments)
        .where(
          and(
            eq(attachments.entityType, 'expense_request'),
            inArray(attachments.entityId, kept.map((row) => row.id)),
          ),
        )
    : [];
  const byRequest = new Map<string, string[]>();
  for (const photo of photos) {
    byRequest.set(photo.entityId, [...(byRequest.get(photo.entityId) ?? []), photo.id]);
  }
  return kept.map((row) => ({ ...row, photoIds: byRequest.get(row.id) ?? [] }));
}

/**
 * The warehouses a person may name on a report filed from /profile: the ones
 * they are ASSIGNED to, active — one list for the picker and for the door
 * that re-checks the post (#514), so a hand-typed uuid of somebody else's
 * warehouse is refused rather than stamped on the audit row.
 */
export async function reporterWarehouses(userId: string) {
  return db
    .select({ id: warehouses.id, code: warehouses.code })
    .from(userWarehouses)
    .innerJoin(warehouses, eq(userWarehouses.warehouseId, warehouses.id))
    .where(and(eq(userWarehouses.userId, userId), eq(warehouses.active, true)))
    .orderBy(asc(warehouses.code));
}

/** The operator's own recent reports, for the fold's status list. */
export async function myExpenseRequests(actorId: string, limit = 5) {
  return db
    .select({
      id: expenseRequests.id,
      amount: expenseRequests.amount,
      currency: expenseRequests.currency,
      note: expenseRequests.note,
      status: expenseRequests.status,
      rejectReason: expenseRequests.rejectReason,
      paidBySelf: expenseRequests.paidBySelf,
      createdAt: expenseRequests.createdAt,
    })
    .from(expenseRequests)
    .where(eq(expenseRequests.createdBy, actorId))
    .orderBy(desc(expenseRequests.createdAt))
    .limit(limit);
}

/**
 * Who filed a report and whether they paid it themselves — what «Hodim
 * kontragentini ochish» needs, read by the REQUEST id so the login it opens an
 * account for comes from the row and never from the form (#514).
 */
export async function expenseRequestReporter(id: string) {
  const [row] = await db
    .select({ createdBy: expenseRequests.createdBy, paidBySelf: expenseRequests.paidBySelf })
    .from(expenseRequests)
    .where(eq(expenseRequests.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * The claim: exactly one «Kiritish» wins. Returns the claimed row; a second
 * press — another accountant, another tab — gets `already_decided` instead
 * of a second expense.
 */
export async function claimExpenseRequest(id: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new ExpenseRequestError('unauthenticated');
  const [row] = await db
    .update(expenseRequests)
    .set({ status: 'done', decidedBy: ctx.actorId, decidedAt: new Date() })
    .where(and(eq(expenseRequests.id, id), eq(expenseRequests.status, 'open')))
    .returning();
  if (!row) throw new ExpenseRequestError('already_decided');
  return row;
}

/** The expense was refused — the claim goes back, typed inputs and all. */
export async function releaseExpenseRequest(id: string) {
  await db
    .update(expenseRequests)
    .set({ status: 'open', decidedBy: null, decidedAt: null })
    .where(and(eq(expenseRequests.id, id), eq(expenseRequests.status, 'done')));
}

/** The expense landed — close the loop and tell the operator. */
export async function finishExpenseRequest(id: string, expenseId: string, ctx: AuditContext) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(expenseRequests)
      .set({ expenseId })
      .where(eq(expenseRequests.id, id))
      .returning();
    if (!row) return;
    await emitEvent(tx, {
      type: 'ExpenseRequestDecided',
      payload: {
        requestId: id,
        requestedBy: row.createdBy,
        verdict: 'done',
        amount: row.amount,
        currency: row.currency,
        note: row.note,
      },
      entityType: 'expense_request',
      entityId: id,
      actorId: ctx.actorId,
    });
  });
  await writeAudit(db, ctx, {
    entityType: 'expense_request',
    entityId: id,
    action: 'update',
    after: { status: 'done', expenseId },
  });
}

export async function rejectExpenseRequest(id: string, reason: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new ExpenseRequestError('unauthenticated');
  const clean = reason.trim();
  if (clean.length < 2) throw new ExpenseRequestError('reason_required');
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(expenseRequests)
      .set({
        status: 'rejected',
        rejectReason: clean,
        decidedBy: ctx.actorId,
        decidedAt: new Date(),
      })
      .where(and(eq(expenseRequests.id, id), eq(expenseRequests.status, 'open')))
      .returning();
    if (!row) throw new ExpenseRequestError('already_decided');
    await emitEvent(tx, {
      type: 'ExpenseRequestDecided',
      payload: {
        requestId: id,
        requestedBy: row.createdBy,
        verdict: 'rejected',
        amount: row.amount,
        currency: row.currency,
        note: row.note,
        rejectReason: clean,
      },
      entityType: 'expense_request',
      entityId: id,
      actorId: ctx.actorId,
    });
  });
  await writeAudit(db, ctx, {
    entityType: 'expense_request',
    entityId: id,
    action: 'update',
    after: { status: 'rejected', reason: clean },
  });
}

/**
 * The pair rule (#528): an expense taken back re-opens the report it
 * answered — the fold must stop saying «kiritildi» about voided money.
 * Called from `voidExpense`, best-effort by design (the void itself is the
 * money fact and must not fail on the messenger).
 */
export async function reopenRequestsForExpense(expenseId: string) {
  await db
    .update(expenseRequests)
    .set({ status: 'open', expenseId: null, decidedBy: null, decidedAt: null })
    .where(eq(expenseRequests.expenseId, expenseId));
}
