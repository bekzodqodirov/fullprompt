import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  attachments,
  expenseRequests,
  users,
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
  warehouseId: z.string().uuid(),
  amount: z.number().min(0.01).max(100_000_000),
  currency: z.string().length(3),
  note: z.string().trim().min(2).max(500),
});
export type ExpenseRequestInput = z.infer<typeof expenseRequestSchema>;

export async function requestExpense(input: ExpenseRequestInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new ExpenseRequestError('unauthenticated');
  // Names for the Telegram message, read BEFORE the transaction opens — the
  // pool is off-limits inside one (#714).
  const [warehouse, requester] = await Promise.all([
    db.query.warehouses.findFirst({ where: eq(warehouses.id, input.warehouseId) }),
    db.query.users.findFirst({ where: eq(users.id, ctx.actorId) }),
  ]);
  if (!warehouse) throw new ExpenseRequestError('warehouse_not_found');

  try {
    await db.transaction(async (tx) => {
      // The insert and the event share one transaction: a request nobody is
      // ever pinged about is a report that silently vanished.
      await tx.insert(expenseRequests).values({
        id: input.id,
        warehouseId: input.warehouseId,
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
          warehouseCode: warehouse.code,
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
  await writeAudit(db, { ...ctx, warehouseId: input.warehouseId }, {
    entityType: 'expense_request',
    entityId: input.id,
    action: 'create',
    after: { amount: input.amount, currency: input.currency, note: input.note },
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
      amount: expenseRequests.amount,
      currency: expenseRequests.currency,
      note: expenseRequests.note,
      status: expenseRequests.status,
      expenseId: expenseRequests.expenseId,
      warehouseId: expenseRequests.warehouseId,
      createdAt: expenseRequests.createdAt,
      requesterName: users.fullName,
    })
    .from(expenseRequests)
    .innerJoin(warehouses, eq(expenseRequests.warehouseId, warehouses.id))
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
      createdAt: expenseRequests.createdAt,
    })
    .from(expenseRequests)
    .where(eq(expenseRequests.createdBy, actorId))
    .orderBy(desc(expenseRequests.createdAt))
    .limit(limit);
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
