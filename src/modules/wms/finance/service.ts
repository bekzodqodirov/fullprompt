import { and, desc, eq, gte, inArray, isNull, lte, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { latestTxDate } from './dates';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  batches,
  clients,
  clientTransactions,
  deals,
  moneyAccounts,
  partnerTransactions,
  partners,
  users,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { rateFor } from '../costing/service';
import { batchRoute } from '../batches/internal';

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

/**
 * The one sign rule of the client ledger (0101): a charge and a refund RAISE
 * what the client owes us, a payment lowers it. Every balance restates this
 * through `signedUsdSql` — `CASE WHEN type = 'charge' … ELSE -…` read a refund
 * as a payment, i.e. money we handed back as money we received, and
 * `tests/unit/client-ledger-sign.test.ts` keeps that shape out of `src/`.
 */
export const LEDGER_TYPES = ['charge', 'payment', 'refund'] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

/** +amount_usd for a charge or a refund, −amount_usd for a payment. */
export function signedUsdSql(table: { type: AnyColumn; amountUsd: AnyColumn } = clientTransactions): SQL {
  return sql`(CASE WHEN ${table.type} = 'payment' THEN -${table.amountUsd} ELSE ${table.amountUsd} END)`;
}

/**
 * Money RECEIVED net of money handed back: +payment, −refund, 0 for a charge.
 * «To'landi» on a screen that also shows a balance must be this, or the two
 * columns stop adding up to it.
 */
export function netPaidUsdSql(table: { type: AnyColumn; amountUsd: AnyColumn } = clientTransactions): SQL {
  return sql`(CASE WHEN ${table.type} = 'payment' THEN ${table.amountUsd} WHEN ${table.type} = 'refund' THEN -${table.amountUsd} ELSE 0 END)`;
}

/** The same rule for a row already in hand (screens, the cabinet, the bot). */
export function signedUsd(row: { type: string; amountUsd: number }): number {
  return row.type === 'payment' ? -row.amountUsd : row.amountUsd;
}

export const transactionSchema = z
  .object({
    clientId: z.string().uuid(),
    type: z.enum(LEDGER_TYPES),
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
  .refine((v) => v.type !== 'charge' || !v.method, { message: 'method_on_charge' });
export type TransactionInput = z.infer<typeof transactionSchema>;

export async function addTransaction(input: TransactionInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new FinanceError('unauthenticated');
  if (input.txDate > latestTxDate()) throw new FinanceError('future_date');
  // A named deal must be THIS client's. The deal id steers the deferral
  // netting (#251) — a payment parked on another client's deal would quietly
  // re-open their handover gate — and a select's value is a forged post until
  // the server has checked it (the inline-picker rule, #507).
  if (input.dealId) {
    const deal = await db.query.deals.findFirst({ where: eq(deals.id, input.dealId) });
    if (!deal || deal.clientId !== input.clientId) throw new FinanceError('deal_mismatch');
  }
  // A price on an INTERNAL truck is refused here, not merely left off the
  // screen (#531): the pricing form posts a batch id, and a hand-built post
  // would otherwise bill a client for a leg the owner never bills (C1a,
  // 2026-09-24). A payment may still name any truck — money received is not
  // a price.
  if (input.type === 'charge' && input.batchId) {
    const route = await batchRoute(input.batchId);
    if (!route) throw new FinanceError('batch_not_found');
    if (route.internal) throw new FinanceError('internal_batch');
  }
  // A refund is money that LEFT a kassa for the client (R6a): it names the
  // box, never a truck (it is not a price) and never a partner (a partner-
  // routed payment is the settlement screen's). The database says the same
  // (client_transactions_refund_check); refused here in words first.
  if (input.type === 'refund') {
    if (!input.accountId) throw new FinanceError('account_required');
    if (input.batchId) throw new FinanceError('refund_on_batch');
  }
  // A named cash box must speak the row's currency. The till balances sum
  // NATIVE amounts per box, so 500 USD dropped into a som till reads as 500
  // som — ~$500 quietly vanishing from the Balans while the drawer count can
  // never reconcile. One slip of an 86-option dropdown; refused, not trusted.
  if (input.accountId) {
    const [account] = await db
      .select({ currency: moneyAccounts.currency })
      .from(moneyAccounts)
      .where(eq(moneyAccounts.id, input.accountId));
    if (account && account.currency !== input.currency) {
      throw new FinanceError('account_currency_mismatch');
    }
  }
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
      method: input.type === 'charge' ? null : (input.method ?? 'cash'),
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

/**
 * Put an unplaced payment into the cash box it actually landed in (audit A2).
 *
 * A payment saved before the kassa became required took its amount off the
 * Balans receivable and put it in no till, and nothing on any screen could
 * say where it went — the only UPDATE this table had was the void. The claim
 * is the WHERE: only a live payment with no box and no partner (a settlement's
 * money is placed in the firm's account, never a till) can be placed, once,
 * and only into a box speaking its currency — the ledger rule every door
 * already asks.
 */
export async function placePayment(id: string, accountId: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new FinanceError('unauthenticated');
  const row = await db.query.clientTransactions.findFirst({ where: eq(clientTransactions.id, id) });
  if (!row || row.type !== 'payment' || row.voidedAt) throw new FinanceError('not_found');
  if (row.partnerId) throw new FinanceError('settlement_placed');
  const [account] = await db
    .select({ currency: moneyAccounts.currency, active: moneyAccounts.active })
    .from(moneyAccounts)
    .where(eq(moneyAccounts.id, accountId));
  if (!account || !account.active) throw new FinanceError('not_found');
  if (account.currency !== row.currency) throw new FinanceError('account_currency_mismatch');
  const placed = await db
    .update(clientTransactions)
    .set({ accountId })
    .where(
      and(
        eq(clientTransactions.id, id),
        isNull(clientTransactions.accountId),
        isNull(clientTransactions.partnerId),
        isNull(clientTransactions.voidedAt),
      ),
    )
    .returning({ id: clientTransactions.id });
  if (placed.length === 0) throw new FinanceError('already_placed');
  await writeAudit(db, ctx, {
    entityType: 'client_transaction',
    entityId: id,
    action: 'update',
    before: { accountId: null },
    after: { accountId },
  });
}

export async function voidTransaction(id: string, reason: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new FinanceError('unauthenticated');
  const row = await db.query.clientTransactions.findFirst({
    where: eq(clientTransactions.id, id),
  });
  if (!row) throw new FinanceError('not_found');
  if (row.voidedAt) throw new FinanceError('already_voided');
  // A three-cornered settlement is ONE agreement with two halves (#415), and
  // `voidPartnerTx` has always taken the client half with it. This is the
  // mirror, which was missing: voiding the client half alone left our debt to
  // the firm forgiven with nothing standing behind it, and only that partner's
  // ledger — read row by row — could ever show it. Matched on the FK that
  // DEFINES the pair, not on the client row's own partner_id, because only
  // `recordSettlement` ever sets `client_tx_id`.
  const paired = await db.transaction(async (tx) => {
    await tx
      .update(clientTransactions)
      .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason })
      .where(eq(clientTransactions.id, id));
    return tx
      .update(partnerTransactions)
      .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason })
      .where(
        and(eq(partnerTransactions.clientTxId, id), isNull(partnerTransactions.voidedAt)),
      )
      .returning({ id: partnerTransactions.id });
  });
  await writeAudit(db, ctx, {
    entityType: 'client_transaction',
    entityId: id,
    action: 'void',
    after: { reason, partnerTxIds: paired.map((p) => p.id) },
  });
  for (const half of paired) {
    await writeAudit(db, ctx, {
      entityType: 'partner_transaction',
      entityId: half.id,
      action: 'void',
      after: { reason, from: 'client_transaction', clientTxId: id },
    });
  }
}

/** USD balance of one client: Σ charges − Σ payments (active rows only). */
/**
 * Live ledger rows dated after today — typed before `future_date` existed.
 * The balance screens count them and the ageing report (as of today) does
 * not, so the report says how many there are instead of silently differing.
 */
export async function futureDatedEntries(): Promise<{ count: number; usd: number }> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      usd: sql<string>`coalesce(sum(${signedUsdSql()}), 0)`,
    })
    .from(clientTransactions)
    .where(and(isNull(clientTransactions.voidedAt), sql`${clientTransactions.txDate} > CURRENT_DATE`));
  return { count: Number(row?.count ?? 0), usd: Math.round(Number(row?.usd ?? 0) * 100) / 100 };
}

export async function clientBalanceUsd(clientId: string): Promise<number> {
  const [row] = await db
    .select({
      balance: sql<string>`coalesce(sum(${signedUsdSql()}), 0)`,
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
 * Only movements ON a deferred deal count. A charge posted from batch pricing
 * carries no deal, so an old unrelated debt keeps blocking exactly as it
 * should: the deferral was granted for one job, not for the client.
 *
 * What is deferred is what is still OWED on that job — charges MINUS payments
 * against it. Summing the charges alone was a hole in the direction that
 * costs money: a client who deferred a $1000 job and then PAID it kept the
 * full $1000 deferred, and the gate subtracts this from the balance, so an
 * unrelated $500 that really was outstanding came out negative and the
 * warehouse handed over the cargo — no override pressed, nothing in the audit
 * trail saying anybody decided to.
 *
 * Clamped at zero PER DEAL, not over the sum: overpaying one job by $200 must
 * not hand out $200 of forgiveness on another.
 */
/**
 * What counts as a LIVE deferral, in one place.
 *
 * Written once because two things ask it now — the handover gate through
 * `deferredBalanceUsd`, and the upsale payout, which by law 4 must not be
 * stricter than the gate that already released the cargo. A deferral whose
 * date has passed is no longer a deferral and the hourly sweep may not have
 * run yet, so neither caller may honour it in the meantime (#251).
 */
export function liveDeferralWhere() {
  return and(
    sql`${deals.deferredAt} IS NOT NULL`,
    isNull(deals.deferralEndedAt),
    sql`(${deals.deferUntilAllArrived} OR ${deals.deferUntilDate} >= CURRENT_DATE)`,
  );
}

export async function deferredBalanceUsd(clientId: string): Promise<number> {
  const owedPerDeal = db
    .select({
      owed: sql<string>`greatest(
        coalesce(sum(${signedUsdSql()}), 0), 0)`.as('owed'),
    })
    .from(clientTransactions)
    .innerJoin(deals, eq(clientTransactions.dealId, deals.id))
    .where(
      and(
        eq(clientTransactions.clientId, clientId),
        isNull(clientTransactions.voidedAt),
        liveDeferralWhere(),
      ),
    )
    .groupBy(clientTransactions.dealId)
    .as('owed_per_deal');

  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${owedPerDeal.owed}), 0)` })
    .from(owedPerDeal);
  return Math.round(Number(row?.total ?? 0) * 100) / 100;
}

/** Per-client totals for the balances screen — only clients with any activity. */
export async function clientBalances(ownerId?: string) {
  const rows = await db
    .select({
      clientId: clientTransactions.clientId,
      clientCode: clients.clientCode,
      clientName: clients.name,
      chargesUsd: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.type} = 'charge'), 0)`,
      paymentsUsd: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.type} = 'payment'), 0)`,
      refundsUsd: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.type} = 'refund'), 0)`,
      lastAt: sql<string>`max(${clientTransactions.createdAt})`,
    })
    .from(clientTransactions)
    .innerJoin(clients, eq(clientTransactions.clientId, clients.id))
    .where(
      and(
        isNull(clientTransactions.voidedAt),
        // A seller reads their own book and nothing else. `undefined` is the
        // only way to ask for everything, so a caller that forgets to decide
        // gets the old behaviour visibly rather than by accident.
        ownerId ? eq(clients.salesManagerId, ownerId) : undefined,
      ),
    )
    .groupBy(clientTransactions.clientId, clients.clientCode, clients.name);
  return rows
    .map((r) => ({
      clientId: r.clientId,
      clientCode: r.clientCode,
      clientName: r.clientName,
      chargesUsd: Math.round(Number(r.chargesUsd) * 100) / 100,
      // NET of what was handed back (R6a), so the screen's two columns still
      // add up to the balance beside them.
      paymentsUsd: Math.round((Number(r.paymentsUsd) - Number(r.refundsUsd)) * 100) / 100,
      refundsUsd: Math.round(Number(r.refundsUsd) * 100) / 100,
      balanceUsd:
        Math.round((Number(r.chargesUsd) - Number(r.paymentsUsd) + Number(r.refundsUsd)) * 100) / 100,
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
      /**
       * WHICH JOB this money answers. `deal_id` has been written by the
       * payment form since #531 and read by nobody but the deferral netting —
       * so the owner would pick a deal, save, and watch it become invisible
       * («bitim belgilanadgan joyda birga berish kerak», 2026-09-14). A LEFT
       * join: most money names no job, and that is not a defect.
       */
      dealCode: deals.code,
    })
    .from(clientTransactions)
    .innerJoin(users, eq(clientTransactions.createdBy, users.id))
    .leftJoin(batches, eq(clientTransactions.batchId, batches.id))
    .leftJoin(deals, eq(clientTransactions.dealId, deals.id))
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

// ---------------------------------------------------------------------------
// The payments register (round 29) — «kimdan qancha pul olganimni qanday
// yozaman?» answered as a screen: every incoming payment in a period, with
// the client, the cash box it landed in and who recorded it. Writing stays
// where it always was (the client's ledger form); this is the READ the
// accountant was keeping in a notebook.
// ---------------------------------------------------------------------------

export interface PaymentRegisterRow {
  id: string;
  txDate: string;
  clientId: string;
  clientCode: string;
  clientName: string;
  amount: string;
  currency: string;
  amountUsd: string;
  method: string | null;
  accountName: string | null;
  /**
   * Named when the money went into a counterparty's account instead of a till
   * of ours (a three-cornered settlement). The row belongs in the register —
   * the client really did pay — but a blank cash box on it is not the same
   * fact as an unplaced payment, and the screen was printing both in red.
   */
  partnerName: string | null;
  note: string | null;
  enteredBy: string | null;
}

/**
 * «Payments with no till», whenever they were made (audit A2): the accountant's
 * home counter, the Balans line and the register's unplaced view read this one
 * predicate. Since cash boxes exist only — a payment older than the first box
 * is inside some box's counted opening balance and has nowhere to be placed.
 */
export function unplacedPaymentSql() {
  return and(
    isNull(clientTransactions.accountId),
    isNull(clientTransactions.partnerId),
    sql`${clientTransactions.txDate} >= (SELECT min(created_at)::date FROM money_accounts)`,
  );
}

export async function paymentsRegister(
  from: string,
  to: string,
  ownerId?: string,
  opts: { unplaced?: boolean } = {},
): Promise<{ rows: PaymentRegisterRow[]; totalUsd: number; count: number; truncated: boolean }> {
  // The unplaced view ignores the period: a payment left unplaced in March is
  // still work in September.
  const when = opts.unplaced
    ? unplacedPaymentSql()
    : and(gte(clientTransactions.txDate, from), lte(clientTransactions.txDate, to));
  const rows = await db
    .select({
      id: clientTransactions.id,
      txDate: clientTransactions.txDate,
      clientId: clientTransactions.clientId,
      clientCode: clients.clientCode,
      clientName: clients.name,
      amount: clientTransactions.amount,
      currency: clientTransactions.currency,
      amountUsd: clientTransactions.amountUsd,
      method: clientTransactions.method,
      accountName: moneyAccounts.name,
      partnerName: partners.name,
      note: clientTransactions.note,
      enteredBy: users.fullName,
    })
    .from(clientTransactions)
    .innerJoin(clients, eq(clientTransactions.clientId, clients.id))
    .leftJoin(moneyAccounts, eq(clientTransactions.accountId, moneyAccounts.id))
    .leftJoin(partners, eq(clientTransactions.partnerId, partners.id))
    .leftJoin(users, eq(clientTransactions.createdBy, users.id))
    .where(
      and(
        eq(clientTransactions.type, 'payment'),
        isNull(clientTransactions.voidedAt),
        when,
        ownerId ? eq(clients.salesManagerId, ownerId) : undefined,
      ),
    )
    .orderBy(desc(clientTransactions.txDate), desc(clientTransactions.createdAt))
    .limit(2000);
  // The TOTAL is aggregated over the whole period, never over the fetched
  // slice: the rows are capped for the screen, and a «jami» computed from a
  // silently clipped list would understate the year the moment the register
  // outgrows the cap — while cash-flow, summing the same period uncapped,
  // says otherwise on the next tab. No silent caps: `truncated` tells the
  // screen and the XLSX to say «newest 2000 of N».
  const [agg] = await db
    .select({
      totalUsd: sql<string>`coalesce(sum(${clientTransactions.amountUsd}), 0)`,
      n: sql<number>`count(*)`,
    })
    .from(clientTransactions)
    .where(
      and(
        eq(clientTransactions.type, 'payment'),
        isNull(clientTransactions.voidedAt),
        when,
        // The total has to be scoped with the rows or the screen contradicts
        // itself — «jami» over the company above a list of one seller's
        // payments. A subquery rather than a join, so the unscoped path stays
        // byte-identical to what it has always been.
        ownerId
          ? inArray(
              clientTransactions.clientId,
              db.select({ id: clients.id }).from(clients).where(eq(clients.salesManagerId, ownerId)),
            )
          : undefined,
      ),
    );
  const count = Number(agg?.n ?? rows.length);
  return {
    rows,
    totalUsd: Math.round(Number(agg?.totalUsd ?? 0) * 100) / 100,
    count,
    truncated: rows.length < count,
  };
}

/**
 * Balance and live-deferral totals for MANY clients, in one query each.
 *
 * The per-client pair above is right for a counter where one customer is
 * standing; a payout queue asks about every seller's every job at once, and
 * calling them per row is the shape rounds 45, 68 and 108 each found
 * saturating the one Node process (#432). Same two predicates, one home.
 */
export async function balancesForClients(
  clientIds: string[],
): Promise<Map<string, { balanceUsd: number; deferredUsd: number }>> {
  const out = new Map<string, { balanceUsd: number; deferredUsd: number }>();
  const ids = [...new Set(clientIds)].filter(Boolean);
  if (ids.length === 0) return out;

  const balances = await db
    .select({
      clientId: clientTransactions.clientId,
      balance: sql<string>`coalesce(sum(${signedUsdSql()}), 0)`,
    })
    .from(clientTransactions)
    .where(and(inArray(clientTransactions.clientId, ids), isNull(clientTransactions.voidedAt)))
    .groupBy(clientTransactions.clientId);

  const perDeal = db
    .select({
      clientId: clientTransactions.clientId,
      dealId: clientTransactions.dealId,
      owed: sql<string>`greatest(
        coalesce(sum(${signedUsdSql()}), 0), 0)`.as('owed'),
    })
    .from(clientTransactions)
    .innerJoin(deals, eq(clientTransactions.dealId, deals.id))
    .where(
      and(
        inArray(clientTransactions.clientId, ids),
        isNull(clientTransactions.voidedAt),
        liveDeferralWhere(),
      ),
    )
    .groupBy(clientTransactions.clientId, clientTransactions.dealId)
    .as('owed_per_deal');

  const deferrals = await db
    .select({
      clientId: perDeal.clientId,
      total: sql<string>`coalesce(sum(${perDeal.owed}), 0)`,
    })
    .from(perDeal)
    .groupBy(perDeal.clientId);

  const money = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;
  for (const id of ids) out.set(id, { balanceUsd: 0, deferredUsd: 0 });
  for (const r of balances) {
    const row = out.get(r.clientId);
    if (row) row.balanceUsd = money(r.balance);
  }
  for (const r of deferrals) {
    const row = r.clientId ? out.get(r.clientId) : undefined;
    if (row) row.deferredUsd = money(r.total);
  }
  return out;
}
