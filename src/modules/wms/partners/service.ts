import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  batches,
  clients,
  clientTransactions,
  costEntries,
  expenses,
  moneyAccounts,
  partners,
  partnerTransactions,
  partnerTypes,
  users,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { rateFor } from '../costing/service';

/**
 * Kontragentlar — the other side of the money (round 39, the owner's three
 * cases in one shape).
 *
 * The client ledger answers "who owes US". Nothing answered "who do WE owe",
 * so a truck taken on credit was a cost with no creditor, customs paid out of
 * another firm's account looked like our cash leaving, and the two men who
 * wire som into the company account and collect dollars from the till existed
 * only in somebody's notebook.
 *
 * One account per counterparty, five kinds of row, and the rule that keeps
 * the reports honest: **a cost and a debt are two different facts**. Entering
 * a cost against a partner does not move money; paying the partner does, and
 * the cost is not counted twice because the payment is not a cost.
 */

export class PartnerError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** Rows that RAISE what we owe. The rest lower it (`adjust` does either). */
const RAISING = ['charge', 'receipt'] as const;

export const PARTNER_TX_TYPES = ['charge', 'receipt', 'payment', 'offset', 'adjust'] as const;
export type PartnerTxType = (typeof PARTNER_TX_TYPES)[number];

/** Types that moved real money, and so must name the cash box that moved. */
export const CASH_TYPES: PartnerTxType[] = ['receipt', 'payment'];

/**
 * Does this row push what we owe UP? The one question a ledger row's colour
 * and sign both answer, and the ledger page used to answer it differently
 * from `balanceExpr` — which is the only opinion that decides the total.
 *
 * `adjust` is the kind whose SIGN is the meaning: a positive correction raises
 * the debt, a negative one lowers it, and the balance adds it signed. Reading
 * it as a reduction printed a +50 correction as «−$50.00» in green under a
 * balance it had just pushed up, so the rows stopped adding to the figure
 * above them. Exported so the screen and the sum cannot drift again.
 */
export function raisesBalance(type: string, amountUsd: number): boolean {
  if (type === 'adjust') return amountUsd > 0;
  return (RAISING as readonly string[]).includes(type);
}

/**
 * The «kimga qarzdormiz» register, grouped.
 *
 * Grouping runs over EVERY type, including the hidden ones: `listPartnerTypes`
 * returns active types only, so an account whose type was hidden on
 * /admin/partner-types matched no group and vanished from the screen — while
 * its debt stayed in the total above it, and its card became reachable only by
 * typing the uuid. Hiding a type means "do not offer it for new accounts", not
 * "delete the accounts already under it".
 */
export function groupPartnersByType<T extends { code: string }>(
  rows: PartnerRow[],
  types: T[],
): { type: T; rows: PartnerRow[] }[] {
  return types
    .map((type) => ({ type, rows: rows.filter((row) => row.typeCode === type.code) }))
    .filter((group) => group.rows.length > 0);
}

export const partnerSchema = z.object({
  name: z.string().trim().min(2).max(200),
  typeId: z.string().uuid(),
  clientId: z.string().uuid().optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  note: z.string().trim().max(2000).optional().or(z.literal('')),
});

export async function savePartner(
  id: string | null,
  input: z.infer<typeof partnerSchema>,
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new PartnerError('unauthenticated');
  const clientId = input.clientId || null;
  if (clientId) {
    // One account per client, checked here so the screen can say WHY rather
    // than showing a unique-index crash.
    const [taken] = await db
      .select({ id: partners.id })
      .from(partners)
      .where(eq(partners.clientId, clientId))
      .limit(1);
    if (taken && taken.id !== id) throw new PartnerError('client_taken');
  }
  const values = {
    name: input.name,
    typeId: input.typeId,
    clientId,
    phone: input.phone || null,
    note: input.note || null,
  };

  if (id) {
    const before = await db.query.partners.findFirst({ where: eq(partners.id, id) });
    if (!before) throw new PartnerError('not_found');
    await db.update(partners).set(values).where(eq(partners.id, id));
    await writeAudit(db, ctx, {
      entityType: 'partner',
      entityId: id,
      action: 'update',
      before: { name: before.name, typeId: before.typeId, clientId: before.clientId },
      after: values,
    });
    return id;
  }

  const [row] = await db
    .insert(partners)
    .values({ ...values, createdBy: ctx.actorId })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'partner',
    entityId: row!.id,
    action: 'create',
    after: values,
  });
  return row!.id;
}

export async function setPartnerActive(id: string, active: boolean, ctx: AuditContext) {
  if (!ctx.actorId) throw new PartnerError('unauthenticated');
  await db.update(partners).set({ active }).where(eq(partners.id, id));
  await writeAudit(db, ctx, {
    entityType: 'partner',
    entityId: id,
    action: 'update',
    after: { active },
  });
}

export const partnerTxSchema = z
  .object({
    partnerId: z.string().uuid(),
    type: z.enum(PARTNER_TX_TYPES),
    amount: z.number().max(1_000_000_000),
    currency: z.string().length(3).toUpperCase(),
    txDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    accountId: z.string().uuid().optional().or(z.literal('')),
    batchId: z.string().uuid().optional().or(z.literal('')),
    note: z.string().trim().max(2000).optional().or(z.literal('')),
  })
  // Zero is never an entry; only a correction may be negative.
  .refine((v) => (v.type === 'adjust' ? v.amount !== 0 : v.amount > 0), {
    message: 'amount',
  })
  // The database enforces this too — stated twice on purpose, because the
  // screen must be able to say which field is wrong.
  .refine((v) => CASH_TYPES.includes(v.type) === Boolean(v.accountId), {
    message: 'account',
  });
export type PartnerTxInput = z.infer<typeof partnerTxSchema>;

/**
 * One row on a partner's account. FX is frozen at entry (#108): a rate
 * corrected next month must not silently rewrite a settled debt.
 */
export async function addPartnerTx(input: PartnerTxInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new PartnerError('unauthenticated');
  // A named cash box must speak the row's currency (the ledger rule).
  if (input.accountId) {
    const [account] = await db
      .select({ currency: moneyAccounts.currency })
      .from(moneyAccounts)
      .where(eq(moneyAccounts.id, input.accountId));
    if (account && account.currency !== input.currency) {
      throw new PartnerError('account_currency_mismatch');
    }
  }
  const rate = await rateFor(input.currency, input.txDate);
  if (rate === null) throw new PartnerError('fx_missing');
  const amountUsd = Math.round(input.amount * rate * 100) / 100;

  const [row] = await db
    .insert(partnerTransactions)
    .values({
      partnerId: input.partnerId,
      type: input.type,
      amount: String(input.amount),
      currency: input.currency,
      rateToUsd: String(rate),
      amountUsd: String(amountUsd),
      txDate: input.txDate,
      accountId: input.accountId || null,
      batchId: input.batchId || null,
      note: input.note || null,
      createdBy: ctx.actorId,
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'partner_transaction',
    entityId: row!.id,
    action: 'create',
    after: {
      partnerId: input.partnerId,
      type: input.type,
      amount: input.amount,
      currency: input.currency,
      amountUsd,
    },
  });
  return row!;
}

export async function voidPartnerTx(id: string, reason: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new PartnerError('unauthenticated');
  const row = await db.query.partnerTransactions.findFirst({
    where: eq(partnerTransactions.id, id),
  });
  if (!row) throw new PartnerError('not_found');
  if (row.voidedAt) throw new PartnerError('already_voided');
  await db.transaction(async (tx) => {
    await tx
      .update(partnerTransactions)
      .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason })
      .where(eq(partnerTransactions.id, id));
    // A three-cornered settlement is ONE agreement with two halves. Voiding
    // the partner half while the client half still says "paid" would leave
    // the client's debt forgiven with nothing standing behind it.
    if (row.clientTxId) {
      await tx
        .update(clientTransactions)
        .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason })
        .where(and(eq(clientTransactions.id, row.clientTxId), isNull(clientTransactions.voidedAt)));
    }
    // A charge DERIVED from a cost or an expense is the pair rule's other
    // direction. Voiding the debt says «this firm does not answer for this
    // money» — the cost stays a P&L fact, but it must lose its payer, or the
    // next recompute (any FX save, any batch departure) re-derives the charge
    // the accountant just cancelled, under the original enterer's name. The
    // void of the DEBT without this line was a void that undid itself.

    if (row.costEntryId) {
      await tx
        .update(costEntries)
        .set({ partnerId: null })
        .where(eq(costEntries.id, row.costEntryId));
    }
    if (row.expenseId) {
      await tx.update(expenses).set({ partnerId: null }).where(eq(expenses.id, row.expenseId));
    }
  });
  await writeAudit(db, ctx, {
    entityType: 'partner_transaction',
    entityId: id,
    action: 'void',
    after: {
      reason,
      clientTxId: row.clientTxId,
      // The record that the source fact lost its payer, and to whom it points.
      ...(row.costEntryId ? { unlinkedCostEntry: row.costEntryId } : {}),
      ...(row.expenseId ? { unlinkedExpense: row.expenseId } : {}),
    },
  });
}

/** USD balance of one partner. Positive = we owe them. */
export async function partnerBalanceUsd(partnerId: string): Promise<number> {
  const [row] = await db
    .select({ balance: balanceExpr() })
    .from(partnerTransactions)
    .where(
      and(eq(partnerTransactions.partnerId, partnerId), isNull(partnerTransactions.voidedAt)),
    );
  return Math.round(Number(row?.balance ?? 0) * 100) / 100;
}

function balanceExpr() {
  return sql<string>`coalesce(sum(
    CASE
      WHEN ${partnerTransactions.type} IN ('charge', 'receipt') THEN ${partnerTransactions.amountUsd}
      WHEN ${partnerTransactions.type} = 'adjust' THEN ${partnerTransactions.amountUsd}
      ELSE -${partnerTransactions.amountUsd}
    END), 0)`;
}

export interface PartnerRow {
  id: string;
  name: string;
  typeName: string;
  typeCode: string;
  clientId: string | null;
  clientCode: string | null;
  active: boolean;
  balanceUsd: number;
}

/** Everybody, with what we owe each — the «kimga qarzdormiz» screen. */
export async function listPartners(opts: { includeInactive?: boolean } = {}): Promise<PartnerRow[]> {
  const rows = await db
    .select({
      id: partners.id,
      name: partners.name,
      typeName: partnerTypes.name,
      typeCode: partnerTypes.code,
      clientId: partners.clientId,
      clientCode: clients.clientCode,
      active: partners.active,
      balance: sql<string>`coalesce((
        SELECT sum(CASE
          WHEN pt.type IN ('charge', 'receipt', 'adjust') THEN pt.amount_usd
          ELSE -pt.amount_usd END)
        FROM partner_transactions pt
        WHERE pt.partner_id = ${partners}.id AND pt.voided_at IS NULL), 0)`,
    })
    .from(partners)
    .innerJoin(partnerTypes, eq(partners.typeId, partnerTypes.id))
    .leftJoin(clients, eq(partners.clientId, clients.id))
    .where(opts.includeInactive ? undefined : eq(partners.active, true))
    .orderBy(asc(partnerTypes.sortOrder), asc(partners.name));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    typeName: r.typeName,
    typeCode: r.typeCode,
    clientId: r.clientId,
    clientCode: r.clientCode,
    active: r.active,
    balanceUsd: Math.round(Number(r.balance) * 100) / 100,
  }));
}

/** One partner's account, newest first. */
export async function partnerLedger(partnerId: string, limit = 200) {
  return db
    .select({
      tx: partnerTransactions,
      accountName: moneyAccounts.name,
      batchCode: batches.code,
      authorName: users.fullName,
    })
    .from(partnerTransactions)
    .leftJoin(moneyAccounts, eq(partnerTransactions.accountId, moneyAccounts.id))
    .leftJoin(batches, eq(partnerTransactions.batchId, batches.id))
    .leftJoin(users, eq(partnerTransactions.createdBy, users.id))
    .where(eq(partnerTransactions.partnerId, partnerId))
    .orderBy(desc(partnerTransactions.txDate), desc(partnerTransactions.createdAt))
    .limit(limit);
}

export async function partnerById(id: string) {
  const [row] = await db
    .select({
      partner: partners,
      typeName: partnerTypes.name,
      typeCode: partnerTypes.code,
      clientCode: clients.clientCode,
      clientName: clients.name,
    })
    .from(partners)
    .innerJoin(partnerTypes, eq(partners.typeId, partnerTypes.id))
    .leftJoin(clients, eq(partners.clientId, clients.id))
    .where(eq(partners.id, id))
    .limit(1);
  return row ?? null;
}

export async function listPartnerTypes(includeInactive = false) {
  return db
    .select()
    .from(partnerTypes)
    .where(includeInactive ? undefined : eq(partnerTypes.active, true))
    .orderBy(asc(partnerTypes.sortOrder), asc(partnerTypes.name));
}

export { RAISING };
