import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import { batches, clients, clientTransactions, deals, users } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { rateFor } from '../costing/service';

/**
 * Client money ledger (Phase 2.1, owner's rules): there are NO tariffs — the
 * sales manager and the client agree a price per shipment, so the ledger only
 * records agreed charges (set by VED manager/accountant after customs) and
 * incoming payments (cash/card/transfer, any currency). Everything is frozen
 * to USD at entry time; balance = Σ charges − Σ payments.
 */

export class FinanceError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export const transactionSchema = z
  .object({
    clientId: z.string().uuid(),
    type: z.enum(['charge', 'payment']),
    amount: z.number().positive().max(1_000_000_000),
    currency: z.string().length(3).toUpperCase(),
    method: z.enum(['cash', 'card', 'transfer']).optional(),
    txDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    batchId: z.string().uuid().optional(),
    /** The job this charge is for, when it was raised from a deal card. */
    dealId: z.string().uuid().optional().or(z.literal('')),
    /**
     * Which cash box the money landed in (Phase 2.4). Optional: rows entered
     * before accounts existed have none, and the cash-flow report treats an
     * unassigned payment as money received but not yet placed.
     */
    accountId: z.string().uuid().optional().or(z.literal('')),
    note: z.string().trim().max(2000).optional().or(z.literal('')),
  })
  .refine((v) => v.type === 'payment' || !v.method, { message: 'method_on_charge' });
export type TransactionInput = z.infer<typeof transactionSchema>;

export async function addTransaction(input: TransactionInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new FinanceError('unauthenticated');
  // The rate is frozen NOW — a later FX edit must not move settled money.
  // No rate for the currency yet → the accountant enters one first.
  const rate = await rateFor(input.currency, input.txDate);
  if (rate === null) throw new FinanceError('fx_missing');
  const amountUsd = Math.round(input.amount * rate * 100) / 100;

  const [row] = await db
    .insert(clientTransactions)
    .values({
      clientId: input.clientId,
      type: input.type,
      amount: String(input.amount),
      currency: input.currency,
      rateToUsd: String(rate),
      amountUsd: String(amountUsd),
      method: input.type === 'payment' ? (input.method ?? 'cash') : null,
      txDate: input.txDate,
      batchId: input.batchId ?? null,
      dealId: input.dealId || null,
      accountId: input.accountId || null,
      note: input.note || null,
      createdBy: ctx.actorId,
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'client_transaction',
    entityId: row!.id,
    action: 'create',
    after: {
      clientId: input.clientId,
      type: input.type,
      amount: input.amount,
      currency: input.currency,
      amountUsd,
    },
  });
  return row!;
}

export async function voidTransaction(id: string, reason: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new FinanceError('unauthenticated');
  const row = await db.query.clientTransactions.findFirst({
    where: eq(clientTransactions.id, id),
  });
  if (!row) throw new FinanceError('not_found');
  if (row.voidedAt) throw new FinanceError('already_voided');
  await db
    .update(clientTransactions)
    .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason })
    .where(eq(clientTransactions.id, id));
  await writeAudit(db, ctx, {
    entityType: 'client_transaction',
    entityId: id,
    action: 'void',
    after: { reason },
  });
}

/** USD balance of one client: Σ charges − Σ payments (active rows only). */
export async function clientBalanceUsd(clientId: string): Promise<number> {
  const [row] = await db
    .select({
      balance: sql<string>`coalesce(sum(CASE WHEN ${clientTransactions.type} = 'charge' THEN ${clientTransactions.amountUsd} ELSE -${clientTransactions.amountUsd} END), 0)`,
    })
    .from(clientTransactions)
    .where(and(eq(clientTransactions.clientId, clientId), isNull(clientTransactions.voidedAt)));
  return Math.round(Number(row?.balance ?? 0) * 100) / 100;
}

/**
 * The part of a client's balance that has been deliberately put off.
 *
 * "I'll pay when it is all here" is a decision with an owner and an end
 * (docs/DEALS.md answer 4), and it is worth nothing unless the handover gate
 * honours it — otherwise the warehouse still refuses the cargo, the operator
 * still presses the override, and the reason goes back to being a Telegram
 * message nobody can find later.
 *
 * Only charges raised ON a deferred deal count. A charge posted from batch
 * pricing carries no deal, so an old unrelated debt keeps blocking exactly as
 * it should: the deferral was granted for one job, not for the client.
 */
export async function deferredBalanceUsd(clientId: string): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${clientTransactions.amountUsd}), 0)`,
    })
    .from(clientTransactions)
    .innerJoin(deals, eq(clientTransactions.dealId, deals.id))
    .where(
      and(
        eq(clientTransactions.clientId, clientId),
        eq(clientTransactions.type, 'charge'),
        isNull(clientTransactions.voidedAt),
        sql`${deals.deferredAt} IS NOT NULL`,
        isNull(deals.deferralEndedAt),
        // A deferral whose date has passed is no longer a deferral, and the
        // hourly sweep may not have run yet — the gate must not honour it in
        // the meantime.
        sql`(${deals.deferUntilAllArrived} OR ${deals.deferUntilDate} >= CURRENT_DATE)`,
      ),
    );
  return Math.round(Number(row?.total ?? 0) * 100) / 100;
}

/** Per-client totals for the balances screen — only clients with any activity. */
export async function clientBalances() {
  const rows = await db
    .select({
      clientId: clientTransactions.clientId,
      clientCode: clients.clientCode,
      clientName: clients.name,
      chargesUsd: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.type} = 'charge'), 0)`,
      paymentsUsd: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.type} = 'payment'), 0)`,
      lastAt: sql<string>`max(${clientTransactions.createdAt})`,
    })
    .from(clientTransactions)
    .innerJoin(clients, eq(clientTransactions.clientId, clients.id))
    .where(isNull(clientTransactions.voidedAt))
    .groupBy(clientTransactions.clientId, clients.clientCode, clients.name);
  return rows
    .map((r) => ({
      clientId: r.clientId,
      clientCode: r.clientCode,
      clientName: r.clientName,
      chargesUsd: Math.round(Number(r.chargesUsd) * 100) / 100,
      paymentsUsd: Math.round(Number(r.paymentsUsd) * 100) / 100,
      balanceUsd: Math.round((Number(r.chargesUsd) - Number(r.paymentsUsd)) * 100) / 100,
      lastAt: r.lastAt,
    }))
    .sort((a, b) => b.balanceUsd - a.balanceUsd);
}

/** Full ledger of one client, newest first (void rows included, struck out in UI). */
export async function clientLedger(clientId: string) {
  return db
    .select({
      tx: clientTransactions,
      createdByName: users.fullName,
      batchCode: batches.code,
    })
    .from(clientTransactions)
    .innerJoin(users, eq(clientTransactions.createdBy, users.id))
    .leftJoin(batches, eq(clientTransactions.batchId, batches.id))
    .where(eq(clientTransactions.clientId, clientId))
    .orderBy(desc(clientTransactions.createdAt))
    .limit(500);
}

/** Active charges already entered against one batch (pricing screen). */
export async function batchCharges(batchId: string) {
  return db
    .select({
      tx: clientTransactions,
      clientCode: clients.clientCode,
      clientName: clients.name,
    })
    .from(clientTransactions)
    .innerJoin(clients, eq(clientTransactions.clientId, clients.id))
    .where(and(eq(clientTransactions.batchId, batchId), isNull(clientTransactions.voidedAt)))
    .orderBy(desc(clientTransactions.createdAt));
}
