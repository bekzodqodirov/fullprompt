import { cache } from 'react';
import { and, asc, eq, gte, isNull, lte, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db, type Db, type Tx } from '../../platform/db/client';
import {
  accountTransfers,
  clientTransactions,
  costEntries,
  expenseCategories,
  expenses,
  moneyAccounts,
  partnerTransactions,
  partners,
  recurringExpenses,
  users,
  warehouses,
} from '../../platform/db/schema';
import { diffFields, writeAudit, type AuditContext } from '../../platform/audit/service';
import { rateFor } from '../costing/service';
import { dueNowSql } from './recurring-sql';
import {
  cashClientTxSql,
  cashCostSql,
  cashExpenseSql,
  costCashDay,
  mergedFrom,
} from './cash-rules';
import { latestTxDate } from '../finance/dates';
import { exceedsRowUsd, nativeAmount, signedNativeAmount } from '../finance/money-bounds';
import { tashkentDay } from '../../platform/time/tashkent';

/**
 * Management accounting (Phase 2.4, owner's answers).
 *
 * The cargo side was already complete — `cost_entries` capture what a shipment
 * costs and `cost_allocations` push it down to every box. What the books were
 * missing is the overhead side (rent, salaries…) and somewhere for money to
 * actually sit, which is what makes a P&L and a cash-flow report possible.
 *
 * Deliberately NOT double-entry bookkeeping (owner chose management
 * accounting): no chart of accounts, no debit/credit, no balance sheet. The
 * official books stay with the accountant; these numbers run the business.
 *
 * Money rules follow Phase 2.1 (DECISIONS #108): the FX rate is frozen at
 * entry, so correcting a rate later can never rewrite a month that has
 * already been reported, and mistakes are voided with a reason, never deleted.
 */

export class AccountingError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// --- Categories -------------------------------------------------------------

export const categorySchema = z.object({
  name: z.string().trim().min(2).max(120),
  /** False = never moves money (depreciation): in the P&L, out of the cash flow. */
  cash: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
  active: z.boolean().default(true),
});

export async function listCategories(includeInactive = false) {
  return db
    .select()
    .from(expenseCategories)
    .where(includeInactive ? undefined : eq(expenseCategories.active, true))
    .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.name));
}

export async function saveCategory(
  input: z.infer<typeof categorySchema> & { id?: string },
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new AccountingError('unauthenticated');
  const values = {
    name: input.name,
    cash: input.cash,
    sortOrder: input.sortOrder,
    active: input.active,
  };
  if (!input.id) {
    const [row] = await db.insert(expenseCategories).values(values).returning();
    await writeAudit(db, ctx, {
      entityType: 'expense_category',
      entityId: row!.id,
      action: 'create',
      after: values,
    });
    return row!;
  }
  const id = input.id;
  // The «Naqd» flag is read at REPORT time: flipping it on a kind that has
  // expenses rewrote every past month's cash flow — off deleted the
  // till-paid outflows while the tills stayed moved, on added past
  // depreciation to closed months (U06). Owner's answer (a), 2026-09-25:
  // once any expense of the kind exists, live OR voided, the flag is fixed —
  // make a new kind instead, the same rule as exchange rates (#126). The
  // check and the write share one lock on the category row; a first expense
  // racing this very save is a residual window, stated.
  const { row, before } = await db.transaction(async (tx) => {
    const [stored] = await tx
      .select()
      .from(expenseCategories)
      .where(eq(expenseCategories.id, id))
      .for('update');
    if (!stored) throw new AccountingError('not_found');
    if (stored.cash !== input.cash) {
      const [used] = await tx
        .select({ id: expenses.id })
        .from(expenses)
        .where(eq(expenses.categoryId, id))
        .limit(1);
      if (used) throw new AccountingError('cash_flag_locked');
      // A monthly TEMPLATE locks it too, active or paused (review of wc): the
      // owner is starting from empty (Q7), so the rent's template exists
      // before its first posting. Unticked, every «Oyni yozish» fails the
      // kassa template as `non_cash_category`; ticked, a kassa-less template
      // posts a cash expense with no kassa and no payer every month — the
      // one-sided row U13 forbids, which `addExpense` does not ask about.
      const [template] = await tx
        .select({ id: recurringExpenses.id })
        .from(recurringExpenses)
        .where(eq(recurringExpenses.categoryId, id))
        .limit(1);
      if (template) throw new AccountingError('cash_flag_locked');
    }
    const [updated] = await tx
      .update(expenseCategories)
      .set(values)
      .where(eq(expenseCategories.id, id))
      .returning();
    return { row: updated!, before: stored };
  });
  await writeAudit(db, ctx, {
    entityType: 'expense_category',
    entityId: row.id,
    action: 'update',
    // It was null, so a flipped flag could not be traced afterwards.
    before: { name: before.name, cash: before.cash, sortOrder: before.sortOrder, active: before.active },
    after: values,
  });
  return row;
}

// --- Accounts ---------------------------------------------------------------

export const accountSchema = z.object({
  name: z.string().trim().min(2).max(120),
  currency: z.string().length(3).toUpperCase(),
  kind: z.enum(['cash', 'bank', 'card']),
  /**
   * What was in the box before the system started (owner: "ha kiritamiz").
   * Bounded by the amount columns' numeric(14,2), both signs — the old ±1e9
   * cap made a so'm firm account holding more than ~$80k impossible to open
   * at its true figure (U44). No dollar guard: a till's count is not a row
   * with a rate, and its column (16,2) holds more than this bound.
   */
  openingBalance: signedNativeAmount().default(0),
  openingDate: DATE.optional().or(z.literal('')),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
  active: z.boolean().default(true),
});

export async function listAccounts(includeInactive = false) {
  return db
    .select()
    .from(moneyAccounts)
    .where(includeInactive ? undefined : eq(moneyAccounts.active, true))
    .orderBy(asc(moneyAccounts.sortOrder), asc(moneyAccounts.name));
}

/**
 * Tills something already points at — any row, LIVE OR VOIDED, in any of the
 * six tables that name a kassa, templates included (U29). ONE statement for
 * the whole list (the owner keeps ~86 tills, #432), or for one till when
 * `accountId` is given; on whichever connection the caller holds, so the
 * save below can ask it inside its own lock.
 *
 * Voided rows count because they are still PRINTED in the till's currency on
 * the ledger and transfer lists, and a template counts because re-reading it
 * in another currency fails every monthly post (measured).
 */
export async function tillsInUse(conn: Db | Tx = db, accountId?: string): Promise<Set<string>> {
  const rows = await conn.execute<{ id: string }>(sql`
    SELECT ma.id FROM money_accounts ma
     WHERE ${accountId ? sql`ma.id = ${accountId}::uuid` : sql`TRUE`}
       AND (EXISTS (SELECT 1 FROM client_transactions x WHERE x.account_id = ma.id)
         OR EXISTS (SELECT 1 FROM expenses x WHERE x.account_id = ma.id)
         OR EXISTS (SELECT 1 FROM cost_entries x WHERE x.account_id = ma.id)
         OR EXISTS (SELECT 1 FROM partner_transactions x WHERE x.account_id = ma.id)
         OR EXISTS (SELECT 1 FROM account_transfers x
                     WHERE x.from_account_id = ma.id OR x.to_account_id = ma.id)
         OR EXISTS (SELECT 1 FROM recurring_expenses x WHERE x.account_id = ma.id))
  `);
  return new Set(rows.map((row) => row.id));
}

export async function saveAccount(
  input: z.infer<typeof accountSchema> & { id?: string },
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new AccountingError('unauthenticated');
  const values = {
    name: input.name,
    currency: input.currency,
    kind: input.kind,
    openingBalance: String(input.openingBalance),
    openingDate: input.openingDate || null,
    sortOrder: input.sortOrder,
    active: input.active,
  };
  if (!input.id) {
    const [row] = await db.insert(moneyAccounts).values(values).returning();
    await writeAudit(db, ctx, {
      entityType: 'money_account',
      entityId: row!.id,
      action: 'create',
      after: values,
    });
    return row!;
  }
  const id = input.id;
  // A kassa's currency is FIXED once anything points at it (U29). Every row
  // naming a till was written in the till's currency — every door refuses
  // account_currency_mismatch (#533) — so re-labelling the till re-reads each
  // of those amounts in another currency: the opening, the payments, the
  // expenses, the costs, the transfers, the Balans. There is no legitimate
  // case; a till in a new currency is a NEW till. The check and the write
  // share one lock on the till row; the payment doors read the currency
  // without one, so a first payment racing this very save is a residual
  // window — negligible, stated rather than locked at every door.
  const { row, before } = await db.transaction(async (tx) => {
    const [stored] = await tx
      .select()
      .from(moneyAccounts)
      .where(eq(moneyAccounts.id, id))
      .for('update');
    if (!stored) throw new AccountingError('not_found');
    if (stored.currency !== input.currency && (await tillsInUse(tx, id)).size > 0) {
      throw new AccountingError('currency_locked');
    }
    const [updated] = await tx.update(moneyAccounts).set(values).where(eq(moneyAccounts.id, id)).returning();
    return { row: updated!, before: stored };
  });
  await writeAudit(db, ctx, {
    entityType: 'money_account',
    entityId: row.id,
    action: 'update',
    // The before half used to be null, so a changed currency or opening could
    // not be traced from the history afterwards.
    before: {
      name: before.name,
      currency: before.currency,
      kind: before.kind,
      openingBalance: before.openingBalance,
      openingDate: before.openingDate,
      active: before.active,
    },
    after: values,
  });
  return row;
}

// --- Expenses ---------------------------------------------------------------

export const expenseSchema = z.object({
  categoryId: z.string().uuid(),
  // The column's bound in every currency; the dollar ceiling is the service's (U44).
  amount: nativeAmount(),
  currency: z.string().length(3).toUpperCase(),
  expenseDate: DATE,
  warehouseId: z.string().uuid().optional().or(z.literal('')),
  employeeId: z.string().uuid().optional().or(z.literal('')),
  accountId: z.string().uuid().optional().or(z.literal('')),
  /**
   * Settled THROUGH a partner instead of out of a cash box (round 39): the
   * Chinese warehouses are rented jointly with a transport company and the
   * Chinese staff are paid through it. The expense is ours and belongs in the
   * P&L; the money is not ours to show leaving a till.
   */
  partnerId: z.string().uuid().optional().or(z.literal('')),
  note: z.string().trim().max(2000).optional().or(z.literal('')),
});
export type ExpenseInput = z.infer<typeof expenseSchema>;

/**
 * Does this expense name a kassa or a payer on a NON-cash kind? (U06)
 *
 * A category marked «not cash» (depreciation) never moves money: the cash flow
 * leaves it out by that flag. Naming a kassa on one took it out of the drawer
 * and out of the Balans cash while the cash flow said nothing left — the
 * drawer and the report disagreeing by money that, by the category's own
 * definition, never moved; naming a payer booked a debt for a book entry.
 * Refused, never silently dropped: the expense form's own history records
 * that a silent drop «meant something different from what was typed».
 *
 * Read on the POOL: every caller asks it BEFORE its transaction (#714). A
 * category that does not exist answers false — the insert's FK refuses it.
 */
export async function namesMoneyOnNonCash(
  categoryId: string,
  payer: { accountId?: string | null; partnerId?: string | null },
): Promise<boolean> {
  if (!payer.accountId && !payer.partnerId) return false;
  const [category] = await db
    .select({ cash: expenseCategories.cash })
    .from(expenseCategories)
    .where(eq(expenseCategories.id, categoryId))
    .limit(1);
  return category?.cash === false;
}

/**
 * Does this expense leave its money nowhere? (U13, owner's answer A)
 *
 * A CASH kind with neither a kassa nor a payer: the cash flow counts it as
 * money out while no till moved and no firm is owed — one-sided for ever.
 * The owner made the kassa or the payer MANDATORY, as #994 did for a
 * payment. Asked at the DOORS a person types into (the expense form and the
 * template form; «To'landi» asks its own copy, accounting/recurring.ts),
 * never inside `addExpense`: a non-cash kind (depreciation) names neither by
 * U06's rule, and the upsale payout names its till itself. Read on the POOL, before
 * any claim or transaction (#714). A category that does not exist answers
 * false — the insert's FK refuses it.
 */
export async function needsKassaOrPayer(
  categoryId: string,
  payer: { accountId?: string | null; partnerId?: string | null },
): Promise<boolean> {
  if (payer.accountId || payer.partnerId) return false;
  const [category] = await db
    .select({ cash: expenseCategories.cash })
    .from(expenseCategories)
    .where(eq(expenseCategories.id, categoryId))
    .limit(1);
  return category?.cash === true;
}

/**
 * The WRITE half of an expense, on whichever connection the caller holds.
 *
 * Split out so a caller that is already inside a transaction can record an
 * expense without reaching for the pool — asking for an eleventh connection
 * from inside a transaction holding one of the ten is the permanent,
 * unrecoverable freeze #714 measured, and `tx-pool.test.ts` derives the
 * pooled set transitively so it would find it. `payUpsale` is that caller:
 * the expense and the claim on the offers it settles must be one transaction
 * or the money and its attribution can come apart.
 *
 * Everything that READS — the rate, the cash box's currency — stays outside,
 * in `addExpense`. One writer, two entry points (#513).
 */
export async function addExpenseTx(
  dbOrTx: Db | Tx,
  input: ExpenseInput,
  rate: number,
  ctx: AuditContext,
  /**
   * The month of a recurring template this payment answers (0106). Passed
   * by accounting/recurring.ts ONLY — «To'landi» — never read from a form;
   * `recurring-wire.test.ts` derives that no other caller passes it.
   */
  opts: { recurring?: { id: string; month: string; partial: boolean } } = {},
) {
  if (!ctx.actorId) throw new AccountingError('unauthenticated');
  // No money row dated after tomorrow (#995's rule, U21): a future expense
  // leaves today's kassa and the Balans at once while the P&L, the cash flow
  // and the expense book — «1 January to today» — never show it. Asked in the
  // WRITE half, so the hand-typed expense, the upsale payout, the rasxod
  // xabari's «Kiritish» and «To'landi» are one door. There is no exception
  // any more: the monthly run it existed for posted each template on its own
  // later day out of the kassa — U21's recurring half — and the owner's Q6
  // (money leaves a kassa only when the kassa holder actually pays it)
  // replaced that run with a press dated the day the money left.
  if (input.expenseDate > latestTxDate()) {
    throw new AccountingError('future_date');
  }
  const amountUsd = Math.round(input.amount * rate * 100) / 100;
  // The typo ceiling, in DOLLARS (U44): the native bound is the column's.
  if (exceedsRowUsd(amountUsd)) throw new AccountingError('amount_too_large');

  const [row] = await dbOrTx
    .insert(expenses)
    .values({
      categoryId: input.categoryId,
      amount: String(input.amount),
      currency: input.currency,
      rateToUsd: String(rate),
      amountUsd: String(amountUsd),
      expenseDate: input.expenseDate,
      warehouseId: input.warehouseId || null,
      employeeId: input.employeeId || null,
      // A partner settled it, so no cash box did — holding both would double
      // the money in the cash-flow report.
      accountId: input.partnerId ? null : input.accountId || null,
      partnerId: input.partnerId || null,
      note: input.note || null,
      recurringId: opts.recurring?.id ?? null,
      recurringMonth: opts.recurring?.month ?? null,
      recurringPartial: opts.recurring?.partial ?? false,
      createdBy: ctx.actorId,
    })
    .returning();
  await writeAudit(dbOrTx, ctx, {
    entityType: 'expense',
    entityId: row!.id,
    action: 'create',
    after: {
      amount: input.amount,
      currency: input.currency,
      amountUsd,
      date: input.expenseDate,
      ...(opts.recurring
        ? {
            recurringId: opts.recurring.id,
            recurringMonth: opts.recurring.month,
            recurringPartial: opts.recurring.partial,
          }
        : {}),
    },
  });
  return row!;
}

export async function addExpense(input: ExpenseInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new AccountingError('unauthenticated');
  // The same rule as the client ledger: a named cash box must speak the
  // row's currency, or the till balances stop meaning anything.
  const accountId = input.partnerId ? null : input.accountId || null;
  if (accountId) {
    const [account] = await db
      .select({ currency: moneyAccounts.currency })
      .from(moneyAccounts)
      .where(eq(moneyAccounts.id, accountId));
    if (account && account.currency !== input.currency) {
      throw new AccountingError('account_currency_mismatch');
    }
  }
  // A non-cash kind (depreciation) is a BOOK entry: it names no kassa and no
  // payer (U06) — refused in words, never silently dropped.
  if (await namesMoneyOnNonCash(input.categoryId, input)) {
    throw new AccountingError('non_cash_category');
  }
  const rate = await rateFor(input.currency, input.expenseDate);
  if (rate === null) throw new AccountingError('fx_missing');

  const row = await addExpenseTx(db, input, rate, ctx);
  if (input.partnerId) {
    const { chargeForExpense } = await import('../partners/link');
    await chargeForExpense(row.id, ctx);
  }
  return row;
}

export async function voidExpense(id: string, reason: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new AccountingError('unauthenticated');
  if (!reason.trim()) throw new AccountingError('reason_required');
  const row = await db.query.expenses.findFirst({ where: eq(expenses.id, id) });
  if (!row) throw new AccountingError('not_found');
  if (row.voidedAt) throw new AccountingError('already_voided');
  await db
    .update(expenses)
    .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason.trim() })
    .where(eq(expenses.id, id));
  if (row.partnerId) {
    const { voidChargeForExpense } = await import('../partners/link');
    await voidChargeForExpense(id, reason.trim(), ctx);
  }
  // The pair rule (#528): a rasxod xabari answered by this expense must not
  // keep reading «kiritildi» about money that was taken back — it re-opens
  // on the decider's panel (round 107).
  const { reopenRequestsForExpense } = await import('./expense-requests');
  await reopenRequestsForExpense(id);
  // The same pair rule one module over: a taken-back payout must not leave
  // its offers reading «to'landi» for ever. Best-effort and after the void,
  // like the line above it.
  const { reopenUpsaleForExpense } = await import('../calc/upsale-service');
  await reopenUpsaleForExpense(id).catch(() => undefined);
  await writeAudit(db, ctx, {
    entityType: 'expense',
    entityId: id,
    action: 'void',
    before: { amountUsd: row.amountUsd },
    after: { reason: reason.trim() },
  });
}

export interface ExpenseFilters {
  from?: string;
  to?: string;
  categoryId?: string;
  warehouseId?: string;
}

/** One predicate for the rows AND their total (#513). */
function expenseWhere(filters: ExpenseFilters) {
  const where = [isNull(expenses.voidedAt)];
  if (filters.from) where.push(gte(expenses.expenseDate, filters.from));
  if (filters.to) where.push(lte(expenses.expenseDate, filters.to));
  if (filters.categoryId) where.push(eq(expenses.categoryId, filters.categoryId));
  if (filters.warehouseId) where.push(eq(expenses.warehouseId, filters.warehouseId));
  return and(...where);
}

/**
 * The period's count and dollar total, over the same predicate as the rows
 * and with NO cap (audit A14). The list stops at its newest 500 and the book
 * holds ~20 salaries a month plus rent and every rasxod xabari, so a total
 * summed from the rows on screen silently lost January by August — while the
 * P&L's opex for the same dates, an uncapped sum, did not. The payments
 * register got this shape in round 69 (#533); the expense book had not.
 */
export async function expenseTotals(filters: ExpenseFilters): Promise<{ count: number; totalUsd: number }> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      total: sql<string>`coalesce(sum(${expenses.amountUsd}), 0)`,
    })
    .from(expenses)
    .where(expenseWhere(filters));
  return { count: Number(row?.count ?? 0), totalUsd: Math.round(Number(row?.total ?? 0) * 100) / 100 };
}

export async function listExpenses(filters: ExpenseFilters & { limit?: number }) {
  return db
    .select({
      expense: expenses,
      categoryName: expenseCategories.name,
      warehouseCode: warehouses.code,
      employeeName: users.fullName,
      accountName: moneyAccounts.name,
      // Who settled it, when it was not us. Without this a partner-settled
      // expense is indistinguishable on the list from one entered with no
      // cash box at all, which is the same blank cell for two different facts.
      partnerName: partners.name,
    })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .leftJoin(warehouses, eq(expenses.warehouseId, warehouses.id))
    .leftJoin(users, eq(expenses.employeeId, users.id))
    .leftJoin(moneyAccounts, eq(expenses.accountId, moneyAccounts.id))
    .leftJoin(partners, eq(expenses.partnerId, partners.id))
    .where(expenseWhere(filters))
    .orderBy(sql`${expenses.expenseDate} DESC`, sql`${expenses.createdAt} DESC`)
    .limit(filters.limit ?? 500);
}

// --- Recurring (rent, salaries) ---------------------------------------------
//
// A template is a PROMISE WITH A DAY (owner's Q6, 0106): it never writes
// money by itself. The due list, «To'landi», «Bog'lash» and «Bu oy yo'q»
// live in accounting/recurring.ts; the rule that says which months are owed
// in accounting/recurring-sql.ts. What stays here is the template itself.

export const recurringSchema = expenseSchema
  .omit({ expenseDate: true })
  .extend({
    dayOfMonth: z.number().int().min(1).max(28).default(1),
    active: z.boolean().default(true),
    /**
     * «Birinchi to'lov» (G10): this month or next. A rent created on the
     * 20th with a payday of the 5th would otherwise arrive overdue on the
     * day it is typed. Optional, so a caller that says nothing gets this
     * month — the column's own default.
     */
    firstMonth: z.enum(['this', 'next']).optional(),
  });

export async function listRecurring() {
  return db
    .select({
      recurring: recurringExpenses,
      categoryName: expenseCategories.name,
      categoryCash: expenseCategories.cash,
      employeeName: users.fullName,
      partnerName: partners.name,
      partnerActive: partners.active,
      accountName: moneyAccounts.name,
      accountCurrency: moneyAccounts.currency,
      accountActive: moneyAccounts.active,
    })
    .from(recurringExpenses)
    .innerJoin(expenseCategories, eq(recurringExpenses.categoryId, expenseCategories.id))
    .leftJoin(users, eq(recurringExpenses.employeeId, users.id))
    .leftJoin(partners, eq(recurringExpenses.partnerId, partners.id))
    .leftJoin(moneyAccounts, eq(recurringExpenses.accountId, moneyAccounts.id))
    .orderBy(asc(expenseCategories.sortOrder));
}

/**
 * The dollar ceiling (U44) for a TEMPLATE, at today's rate — «To'landi» asks
 * it again at the payment's own (`addExpenseTx`). No rate yet = nothing to
 * compare with; the press answers `fx_missing` in words.
 */
async function assertRecurringUsd(amount: number, currency: string): Promise<void> {
  const rate = await rateFor(currency, tashkentDay());
  if (rate !== null && exceedsRowUsd(amount * rate)) throw new AccountingError('amount_too_large');
}

/** The first day of the month after `day`'s — string arithmetic, no clock. */
function nextMonthStart(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

/**
 * CREATE a template — and only create (M9). The update branch this used to
 * carry was reachable by a hand-posted `id` and rewrote the category, the
 * person, the warehouse, the payer and `active` with no guard at all; a
 * template's own row control is `updateRecurring`, which asks what it must.
 */
export async function saveRecurring(input: z.infer<typeof recurringSchema>, ctx: AuditContext) {
  if (!ctx.actorId) throw new AccountingError('unauthenticated');
  // The same pair rule `addExpense` enforces, asked HERE — where the person
  // who picked the wrong till is still looking at the form. The two selects
  // are unrelated controls over 86 cash boxes, so choosing a USD till for a
  // som rent is an ordinary slip, and a default kassa that cannot take the
  // template's currency would be offered on every «To'landi».
  if (input.accountId && !input.partnerId) {
    const [account] = await db
      .select({ currency: moneyAccounts.currency })
      .from(moneyAccounts)
      .where(eq(moneyAccounts.id, input.accountId));
    if (account && account.currency !== input.currency) {
      throw new AccountingError('account_currency_mismatch');
    }
  }
  // The non-cash rule (U06), asked where the person is still on the form —
  // the same reason as the pair rule above.
  if (await namesMoneyOnNonCash(input.categoryId, input)) {
    throw new AccountingError('non_cash_category');
  }
  await assertRecurringUsd(input.amount, input.currency);
  // Absent or 'this' = the column default (Tashkent's today, so this month
  // is in the window); 'next' = the first of next month.
  const dueFrom = input.firstMonth === 'next' ? nextMonthStart(tashkentDay()) : undefined;
  const [row] = await db
    .insert(recurringExpenses)
    .values({
      categoryId: input.categoryId,
      amount: String(input.amount),
      currency: input.currency,
      dayOfMonth: input.dayOfMonth,
      warehouseId: input.warehouseId || null,
      employeeId: input.employeeId || null,
      // Paid through a firm, so no till of ours — the expense form's own
      // rule, or every payment would count the money twice (A36).
      accountId: input.partnerId ? null : input.accountId || null,
      partnerId: input.partnerId || null,
      note: input.note || null,
      active: input.active,
      ...(dueFrom ? { dueFrom } : {}),
      createdBy: ctx.actorId,
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'recurring_expense',
    entityId: row!.id,
    action: 'create',
    after: {
      amount: input.amount,
      currency: input.currency,
      dayOfMonth: input.dayOfMonth,
      dueFrom: row!.dueFrom,
    },
  });
  return row!;
}

/**
 * Correct a template in place (audit A32): its amount, its day, stop it —
 * and, since Q6 made the kassa and the payer DEFAULTS for a press rather
 * than facts of a posting, its currency and its usual payer (G1). Those two
 * never touch a posted row: every payment carries its own currency, kassa
 * and payer, which is why #999's «WHAT the cost is stays fixed» may relax
 * for them. The category, the person and the warehouse stay fixed — they
 * are what the P&L line says the cost IS; a different cost is a new
 * template.
 *
 * Absent `currency` / `payer` = keep the stored value, never «clear» — so an
 * edit of the amount or a stop of a template whose usual kassa has since
 * been closed is not refused over a kassa nobody touched.
 */
export const recurringPatchSchema = z.object({
  amount: nativeAmount(),
  dayOfMonth: z.number().int().min(1).max(28),
  active: z.boolean(),
  currency: z.string().length(3).toUpperCase().optional(),
  /** 'till:<id>' | 'partner:<id>' | '' (none — refused on an active cash kind). */
  payer: z
    .string()
    .regex(/^(till|partner):[0-9a-f-]{36}$|^$/i)
    .optional(),
});

/** How a template's stored payer reads in the `payer` select. */
function payerOf(row: { accountId: string | null; partnerId: string | null }): string {
  if (row.partnerId) return `partner:${row.partnerId}`;
  if (row.accountId) return `till:${row.accountId}`;
  return '';
}

export async function updateRecurring(
  id: string,
  patch: z.infer<typeof recurringPatchSchema>,
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new AccountingError('unauthenticated');
  // Every read before the transaction (#714).
  const before = await db.query.recurringExpenses.findFirst({ where: eq(recurringExpenses.id, id) });
  if (!before) throw new AccountingError('not_found');
  const currency = patch.currency ?? before.currency;
  // The ceiling in the currency that will STAND (G2), not the old one.
  await assertRecurringUsd(patch.amount, currency);
  const payerChanged = patch.payer !== undefined && patch.payer.toLowerCase() !== payerOf(before).toLowerCase();
  const next = payerChanged
    ? {
        accountId: patch.payer!.toLowerCase().startsWith('till:') ? patch.payer!.slice(5) : null,
        partnerId: patch.payer!.toLowerCase().startsWith('partner:') ? patch.payer!.slice(8) : null,
      }
    : { accountId: before.accountId, partnerId: before.partnerId };
  if (payerChanged) {
    if (next.accountId) {
      const [till] = await db
        .select({ currency: moneyAccounts.currency, active: moneyAccounts.active })
        .from(moneyAccounts)
        .where(eq(moneyAccounts.id, next.accountId));
      if (!till || !till.active) throw new AccountingError('account_not_found');
      if (till.currency !== currency) throw new AccountingError('account_currency_mismatch');
    }
    if (next.partnerId) {
      const [firm] = await db
        .select({ active: partners.active })
        .from(partners)
        .where(eq(partners.id, next.partnerId));
      if (!firm || !firm.active) throw new AccountingError('partner_not_found');
    }
    // An active cash kind names where its money goes (U13); a stopped one
    // may drop its payer — nothing will ever be pressed on it.
    if (patch.active && (await needsKassaOrPayer(before.categoryId, next))) {
      throw new AccountingError('account_or_payer_required');
    }
    if (await namesMoneyOnNonCash(before.categoryId, next)) {
      throw new AccountingError('non_cash_category');
    }
  } else if (currency !== before.currency && before.accountId && !before.partnerId) {
    // Only the currency moved, and the stored kassa must still speak it.
    const [till] = await db
      .select({ currency: moneyAccounts.currency })
      .from(moneyAccounts)
      .where(eq(moneyAccounts.id, before.accountId));
    if (till && till.currency !== currency) throw new AccountingError('account_currency_mismatch');
  }
  const today = tashkentDay();

  return db.transaction(async (tx) => {
    // The lock every recurring writer takes (pay, link, skip, unskip), and
    // the authoritative «before» for the two transitions below.
    const [locked] = await tx
      .select()
      .from(recurringExpenses)
      .where(eq(recurringExpenses.id, id))
      .for('update');
    if (!locked) throw new AccountingError('not_found');
    // Stopping hides the template's WINDOW; a month whose day has come and
    // nobody closed is a debt, and it must not vanish with a checkbox (M3,
    // O2). The counter's own clause, under the lock, so what blocks here is
    // exactly what the home counts. Only months whose day has not come may
    // drop — the ended-contract case.
    if (locked.active && !patch.active) {
      const [owed] = await tx.execute<{ owed: boolean }>(
        sql`SELECT EXISTS (${dueNowSql(today, id)}) AS owed`,
      );
      if (owed?.owed) throw new AccountingError('recurring_has_arrears');
    }
    // A reactivation starts the window at today's month: the months it was
    // stopped are not owed. Months that carried a posting stay reachable
    // through the occurrence union.
    const reactivated = !locked.active && patch.active;
    const [row] = await tx
      .update(recurringExpenses)
      .set({
        amount: String(patch.amount),
        dayOfMonth: patch.dayOfMonth,
        active: patch.active,
        currency,
        ...(payerChanged ? { accountId: next.partnerId ? null : next.accountId, partnerId: next.partnerId } : {}),
        ...(reactivated ? { dueFrom: today } : {}),
        updatedAt: new Date(),
      })
      .where(eq(recurringExpenses.id, id))
      .returning();
    const change = diffFields(
      {
        amount: Number(locked.amount),
        dayOfMonth: locked.dayOfMonth,
        active: locked.active,
        currency: locked.currency,
        accountId: locked.accountId,
        partnerId: locked.partnerId,
        dueFrom: locked.dueFrom,
      },
      {
        amount: Number(row!.amount),
        dayOfMonth: row!.dayOfMonth,
        active: row!.active,
        currency: row!.currency,
        accountId: row!.accountId,
        partnerId: row!.partnerId,
        dueFrom: row!.dueFrom,
      },
    );
    if (change) {
      await writeAudit(tx, ctx, {
        entityType: 'recurring_expense',
        entityId: id,
        action: 'update',
        before: change.before,
        after: change.after,
      });
    }
    return row!;
  });
}

// --- Transfers between our own accounts -------------------------------------

export const transferSchema = z.object({
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  amountFrom: nativeAmount(),
  amountTo: nativeAmount(),
  transferDate: DATE,
  note: z.string().trim().max(2000).optional().or(z.literal('')),
});

/**
 * Moving our own money (China cash → company account). Recorded separately
 * from expenses on purpose: without this the cash-flow report would read a
 * transfer as money leaving the business.
 */
export async function addTransfer(input: z.infer<typeof transferSchema>, ctx: AuditContext) {
  if (!ctx.actorId) throw new AccountingError('unauthenticated');
  if (input.fromAccountId === input.toAccountId) throw new AccountingError('same_account');
  // #995's rule (U21): a transfer dated next month moved both tills today.
  if (input.transferDate > latestTxDate()) throw new AccountingError('future_date');
  const [from, to] = await Promise.all([
    db.query.moneyAccounts.findFirst({ where: eq(moneyAccounts.id, input.fromAccountId) }),
    db.query.moneyAccounts.findFirst({ where: eq(moneyAccounts.id, input.toAccountId) }),
  ]);
  if (!from || !to) throw new AccountingError('not_found');
  // Between two tills of ONE currency the money out is the money in (audit
  // A35). The two boxes took independent figures, so USD 1,000 → USD 100
  // quietly removed $900 from the kassa totals and the Balans — and cash flow
  // and the P&L both skip transfers, so the loss showed nowhere at all. Across
  // currencies the two figures ARE two facts (the exchange rate), and stay.
  if (from.currency === to.currency && Math.abs(input.amountFrom - input.amountTo) > 0.004) {
    throw new AccountingError('amount_mismatch');
  }
  const rate = await rateFor(from.currency, input.transferDate);
  if (rate === null) throw new AccountingError('fx_missing');
  const amountUsd = Math.round(input.amountFrom * rate * 100) / 100;
  if (exceedsRowUsd(amountUsd)) throw new AccountingError('amount_too_large');

  const [row] = await db
    .insert(accountTransfers)
    .values({
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amountFrom: String(input.amountFrom),
      amountTo: String(input.amountTo),
      amountUsd: String(amountUsd),
      transferDate: input.transferDate,
      note: input.note || null,
      createdBy: ctx.actorId,
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'account_transfer',
    entityId: row!.id,
    action: 'create',
    after: { from: input.fromAccountId, to: input.toAccountId, amount: input.amountFrom },
  });
  return row!;
}

export async function listTransfers(limit = 50) {
  const from = alias(moneyAccounts, 'from_account');
  const to = alias(moneyAccounts, 'to_account');
  return db
    .select({
      transfer: accountTransfers,
      fromName: from.name,
      fromCurrency: from.currency,
      toName: to.name,
      toCurrency: to.currency,
    })
    .from(accountTransfers)
    .innerJoin(from, eq(accountTransfers.fromAccountId, from.id))
    .innerJoin(to, eq(accountTransfers.toAccountId, to.id))
    .orderBy(sql`${accountTransfers.transferDate} DESC`, sql`${accountTransfers.createdAt} DESC`)
    .limit(limit);
}

export async function voidTransfer(id: string, reason: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new AccountingError('unauthenticated');
  if (!reason.trim()) throw new AccountingError('reason_required');
  const row = await db.query.accountTransfers.findFirst({ where: eq(accountTransfers.id, id) });
  if (!row) throw new AccountingError('not_found');
  if (row.voidedAt) throw new AccountingError('already_voided');
  await db
    .update(accountTransfers)
    .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason.trim() })
    .where(eq(accountTransfers.id, id));
  await writeAudit(db, ctx, {
    entityType: 'account_transfer',
    entityId: id,
    action: 'void',
    after: { reason: reason.trim() },
  });
}

/** A kassa-moving row's day: a column, or `costCashDay` for a merged cost. */
type Day = AnyColumn | SQL;

/**
 * The R4 rule (#1012): a row dated before its box's opening count is already
 * inside the counted figure, so the box does not add it again. No opening
 * date = every row counts.
 */
const countedSql = (day: Day) => sql`${day} >= coalesce(${moneyAccounts.openingDate}, '-infinity'::date)`;

/**
 * The aggregate columns one reader wants of each kassa-moving statement:
 * given the row's native amount, its day, its dollars, whether the CASH
 * FLOW counts it (`cash-rules.ts`) and whether its dollars are MISSING (a
 * cost in a currency with no rate yet — `usd` reads it as 0), return the SQL
 * to sum.
 */
type LedgerPick = (amount: AnyColumn, day: Day, usd: SQL, inCashFlow: SQL, noUsd: SQL) => Record<string, SQL>;
type LedgerRow = { id: string | null; type?: string } & Record<string, unknown>;
/** The six statements' rows, in `kassaLedger`'s order. */
type Ledger<R> = [R[], R[], R[], R[], R[], R[]];

/**
 * Every statement that moves a kassa, ONCE — the balances today
 * (`accountBalances`) and over a period (`accountBalancesBetween`) ask the
 * SAME six grouped questions with different sums, so a box's period table
 * cannot disagree with its balance by a rule one of them forgot (#513).
 */
function kassaLedger(pick: LedgerPick): Promise<Ledger<LedgerRow>> {
  const usd = (column: AnyColumn) => sql`coalesce(${column}, 0)`;
  // Only a cost's dollars can be missing today (every other amount_usd is
  // NOT NULL); asked of every statement so a reader never has to know that.
  const noUsd = (column: AnyColumn) => sql`${column} IS NULL`;
  return Promise.all([
    // Payments IN and refunds OUT (R6a) in one pass, split by type.
    db
      .select({
        id: clientTransactions.accountId,
        type: clientTransactions.type,
        ...pick(
          clientTransactions.amount,
          clientTransactions.txDate,
          usd(clientTransactions.amountUsd),
          cashClientTxSql(),
          noUsd(clientTransactions.amountUsd),
        ),
      })
      .from(clientTransactions)
      .innerJoin(moneyAccounts, eq(moneyAccounts.id, clientTransactions.accountId))
      .where(isNull(clientTransactions.voidedAt))
      .groupBy(clientTransactions.accountId, clientTransactions.type),
    db
      .select({
        id: expenses.accountId,
        ...pick(expenses.amount, expenses.expenseDate, usd(expenses.amountUsd), cashExpenseSql(), noUsd(expenses.amountUsd)),
      })
      .from(expenses)
      .innerJoin(moneyAccounts, eq(moneyAccounts.id, expenses.accountId))
      .where(isNull(expenses.voidedAt))
      .groupBy(expenses.accountId),
    // A transfer is our own money changing drawers: never in the cash flow.
    db
      .select({
        id: accountTransfers.toAccountId,
        ...pick(
          accountTransfers.amountTo,
          accountTransfers.transferDate,
          usd(accountTransfers.amountUsd),
          sql`false`,
          noUsd(accountTransfers.amountUsd),
        ),
      })
      .from(accountTransfers)
      .innerJoin(moneyAccounts, eq(moneyAccounts.id, accountTransfers.toAccountId))
      .where(isNull(accountTransfers.voidedAt))
      .groupBy(accountTransfers.toAccountId),
    db
      .select({
        id: accountTransfers.fromAccountId,
        ...pick(
          accountTransfers.amountFrom,
          accountTransfers.transferDate,
          usd(accountTransfers.amountUsd),
          sql`false`,
          noUsd(accountTransfers.amountUsd),
        ),
      })
      .from(accountTransfers)
      .innerJoin(moneyAccounts, eq(moneyAccounts.id, accountTransfers.fromAccountId))
      .where(isNull(accountTransfers.voidedAt))
      .groupBy(accountTransfers.fromAccountId),
    // Round 39: counterparty money moves the same boxes. A cash buyer wiring
    // som into the company account raises it; paying the transport firm out
    // of the till lowers it. Both directions in one pass, split by type —
    // and only those two types carry a box (0054's CHECK), both of them in
    // the cash flow.
    db
      .select({
        id: partnerTransactions.accountId,
        type: partnerTransactions.type,
        ...pick(
          partnerTransactions.amount,
          partnerTransactions.txDate,
          usd(partnerTransactions.amountUsd),
          sql`true`,
          noUsd(partnerTransactions.amountUsd),
        ),
      })
      .from(partnerTransactions)
      .innerJoin(moneyAccounts, eq(moneyAccounts.id, partnerTransactions.accountId))
      .where(isNull(partnerTransactions.voidedAt))
      .groupBy(partnerTransactions.accountId, partnerTransactions.type),
    // Cargo costs paid out of a kassa (0101, owner 3b), in the KASSA's
    // currency — `account_amount`, not the cost's own amount, because customs
    // typed in dollars left a som account. A seventh statement would be one
    // more pooled connection per render of a page that already runs six
    // (the pool is ten); the cost side is the cheapest to add as its own.
    // Dated by the day the DRAWER paid (U07): a merged cost reads the day of
    // the expense it replaced, or the merge moves money across the count.
    db
      .select({
        id: costEntries.accountId,
        ...pick(costEntries.accountAmount, costCashDay, usd(costEntries.amountUsd), cashCostSql(), noUsd(costEntries.amountUsd)),
      })
      .from(costEntries)
      .innerJoin(moneyAccounts, eq(moneyAccounts.id, costEntries.accountId))
      .leftJoin(mergedFrom, eq(mergedFrom.id, costEntries.mergedExpenseId))
      .where(isNull(costEntries.voidedAt))
      .groupBy(costEntries.accountId),
  ] as Promise<LedgerRow[]>[]) as Promise<Ledger<LedgerRow>>;
}

/**
 * Balance per account, in the account's OWN currency.
 *
 * Opening balance + client payments in − expenses out + transfers in −
 * transfers out ± counterparty money. Deliberately native currency, not USD:
 * this number is what someone counts in the cash box, and converting it would
 * make it impossible to reconcile against the actual notes.
 *
 * FIVE grouped queries for every box, not six per box. It used to loop — and
 * the owner keeps 86 cash boxes, so one visit to /accounting issued 516
 * round trips, three times over, because three panels each asked for the same
 * balances. 1,564 queries for one screen. Grouped and memoised per request,
 * the same screen asks 15 questions.
 *
 * `cache` is the same per-request memo `getActor` uses: the accounts panel,
 * the money snapshot and the balance sheet all want this list, and none of
 * them should pay for it twice.
 */
export const accountBalances = cache(async function accountBalances() {
  // The box's opening count is a fact AS OF its opening date (R4 — the date
  // was collected since 0020 and read by nothing, audit A26): a row dated
  // before it is already inside the counted figure, so adding it again
  // doubled it. Such rows stay on the client ledger, the P&L and the cash
  // flow — they happened — and are only kept out of THIS sum; `early`
  // counts them so the accounts screen can say so. No opening date = every
  // row counts, exactly as before.
  const [accounts, [clientRows, spentRows, inRows, outRows, partnerRows, costRows]] = await Promise.all([
    listAccounts(true),
    kassaLedger((amount, day) => ({
      sum: sql<string>`coalesce(sum(${amount}) FILTER (WHERE ${countedSql(day)}), 0)`,
      early: sql<number>`count(*) FILTER (WHERE NOT ${countedSql(day)})`,
    })),
  ]) as [Awaited<ReturnType<typeof listAccounts>>, Ledger<{ id: string | null; type?: string; sum: string; early: number }>];

  const total = (rows: { id: string | null; sum: string }[]) =>
    new Map(rows.filter((row) => row.id !== null).map((row) => [row.id!, Number(row.sum)]));
  const paid = total(clientRows.filter((row) => row.type === 'payment'));
  const refunded = total(clientRows.filter((row) => row.type === 'refund'));
  const spent = total(spentRows);
  const costsPaid = total(costRows);
  const inbound = total(inRows);
  const outbound = total(outRows);
  const partnerIn = total(partnerRows.filter((row) => row.type === 'receipt'));
  const partnerOut = total(partnerRows.filter((row) => row.type === 'payment'));
  const earlyRows = new Map<string, number>();
  for (const row of [...clientRows, ...spentRows, ...inRows, ...outRows, ...partnerRows, ...costRows]) {
    if (row.id) earlyRows.set(row.id, (earlyRows.get(row.id) ?? 0) + Number(row.early));
  }

  return accounts.map((account) => {
    const paidIn = paid.get(account.id) ?? 0;
    const refundedOut = refunded.get(account.id) ?? 0;
    const spentOut = spent.get(account.id) ?? 0;
    const costsOut = costsPaid.get(account.id) ?? 0;
    const transferredIn = inbound.get(account.id) ?? 0;
    const transferredOut = outbound.get(account.id) ?? 0;
    const fromPartners = partnerIn.get(account.id) ?? 0;
    const toPartners = partnerOut.get(account.id) ?? 0;
    const balance =
      Number(account.openingBalance) +
      paidIn -
      refundedOut -
      spentOut -
      costsOut +
      transferredIn -
      transferredOut +
      fromPartners -
      toPartners;
    return {
      id: account.id,
      name: account.name,
      currency: account.currency,
      kind: account.kind,
      active: account.active,
      opening: Number(account.openingBalance),
      paidIn,
      spent: spentOut,
      transferredIn,
      transferredOut,
      // Returned so a row can add up (audit A34): the page printed Kirim and
      // Chiqim without them beside a balance that included them, so a till
      // only a cash buyer used read 0 | +0 | −0 | 100,000,000.
      partnerIn: fromPartners,
      partnerOut: toPartners,
      /** Money handed back to clients out of this box (R6a). */
      refundedOut,
      /** Cargo costs paid out of this box, in its currency (0101). */
      costsOut,
      openingDate: account.openingDate,
      /** Rows dated before the opening count — inside it, so not added (R4). */
      beforeOpening: earlyRows.get(account.id) ?? 0,
      balance: Math.round(balance * 100) / 100,
    };
  });
});

/**
 * A box the Balans still counts: every active one, and a retired one while it
 * holds money (#428 on the accounts side) — ONE predicate for the Balans, the
 * accounting hub's list and the cash-flow's kassa table (audit U13), which
 * had each decided it differently: the hub and the cash flow listed active
 * boxes only, so money the Balans counted was missing from both lists.
 */
export function countedAccount(account: { active: boolean; balance: number }): boolean {
  return account.active || Math.abs(account.balance) > 0.009;
}

/** One box over a period, in its own money — the cash-flow page's kassa table. */
export interface KassaPeriodRow {
  id: string;
  name: string;
  currency: string;
  kind: string;
  active: boolean;
  openingDate: string | null;
  /** At the end of the day before `from`; 0 while the box is not yet counted. */
  opening: number;
  /** The box's own opening count when its date falls inside the period. */
  countedInPeriod: number;
  /** Counted rows dated in the period, transfers included. */
  inflow: number;
  outflow: number;
  transfersIn: number;
  transfersOut: number;
  /** At the end of `to`. opening + countedInPeriod + inflow − outflow. */
  closing: number;
  /** Rows dated in the period but before the box's count (R4): not added. */
  beforeOpeningInPeriod: number;
  /**
   * Dollars of the period's rows, signed as they move the box, UNROUNDED so
   * the reconciliation can add them to the cent: what the cash flow counts
   * and the box counts too (`cashCounted`), what the cash flow counts and the
   * box does not because it is dated before the count (`cashEarly`), what the
   * box counts and the cash flow does not (`tillOnly` — a non-cash category
   * paid from a box), and the box's transfer halves (`transfers`).
   */
  usd: { cashCounted: number; cashEarly: number; tillOnly: number; transfers: number };
  /**
   * The box's OWN money on counted rows dated in the period that carry NO
   * dollar figure (a cost in a currency never rated — U24), signed as they
   * move the box. `usd` above reads each of them as $0, so without this the
   * reconciliation could only find them as a remainder and called that an
   * exchange difference.
   */
  noUsdInPeriod: number;
}

/**
 * Every box's opening, movement and closing over a period (audit U13), from
 * the SAME six statements `accountBalances` runs (`kassaLedger`) with the
 * period's FILTERs — never a second pass of `accountBalances` (the pool is
 * ten) and never a parameter on it (it is memoised per request and three
 * screens call it bare). The R4 rule holds unchanged: a row before its box's
 * count is inside the count.
 *
 * A box whose opening date falls INSIDE the period opens at 0 and receives
 * its count as `countedInPeriod` — the count is an event of the period, not a
 * balance the period started with.
 */
export async function accountBalancesBetween(from: string, to: string): Promise<KassaPeriodRow[]> {
  const inRange = (day: Day) => sql`(${day} >= ${from}::date AND ${day} <= ${to}::date)`;
  const [accounts, statements] = await Promise.all([
    listAccounts(true),
    kassaLedger((amount, day, usd, inCashFlow, noUsd) => ({
      open: sql<string>`coalesce(sum(${amount}) FILTER (WHERE ${countedSql(day)} AND ${day} < ${from}::date), 0)`,
      within: sql<string>`coalesce(sum(${amount}) FILTER (WHERE ${countedSql(day)} AND ${inRange(day)}), 0)`,
      close: sql<string>`coalesce(sum(${amount}) FILTER (WHERE ${countedSql(day)} AND ${day} <= ${to}::date), 0)`,
      early: sql<number>`count(*) FILTER (WHERE NOT ${countedSql(day)} AND ${inRange(day)})`,
      cashCounted: sql<string>`coalesce(sum(${usd}) FILTER (WHERE (${inCashFlow}) AND ${countedSql(day)} AND ${inRange(day)}), 0)`,
      cashEarly: sql<string>`coalesce(sum(${usd}) FILTER (WHERE (${inCashFlow}) AND NOT ${countedSql(day)} AND ${inRange(day)}), 0)`,
      tillOnly: sql<string>`coalesce(sum(${usd}) FILTER (WHERE NOT (${inCashFlow}) AND ${countedSql(day)} AND ${inRange(day)}), 0)`,
      noUsd: sql<string>`coalesce(sum(${amount}) FILTER (WHERE (${noUsd}) AND ${countedSql(day)} AND ${inRange(day)}), 0)`,
    })),
  ]);

  // Which way each statement moves its box — `accountBalances`'s own signs.
  const signOf = (index: number, type: string | undefined): number => {
    if (index === 0) return type === 'payment' ? 1 : type === 'refund' ? -1 : 0;
    if (index === 4) return type === 'receipt' ? 1 : type === 'payment' ? -1 : 0;
    return index === 2 ? 1 : -1;
  };
  type Acc = Omit<KassaPeriodRow, 'id' | 'name' | 'currency' | 'kind' | 'active' | 'openingDate' | 'countedInPeriod'>;
  const empty = (): Acc => ({
    opening: 0,
    inflow: 0,
    outflow: 0,
    transfersIn: 0,
    transfersOut: 0,
    closing: 0,
    beforeOpeningInPeriod: 0,
    usd: { cashCounted: 0, cashEarly: 0, tillOnly: 0, transfers: 0 },
    noUsdInPeriod: 0,
  });
  const per = new Map<string, Acc>();
  statements.forEach((rows, index) => {
    const transfer = index === 2 || index === 3;
    for (const row of rows) {
      const sign = signOf(index, row.type);
      if (!row.id || sign === 0) continue;
      const entry = per.get(row.id) ?? empty();
      const within = Number(row.within);
      entry.opening += sign * Number(row.open);
      entry.closing += sign * Number(row.close);
      if (sign > 0) entry.inflow += within;
      else entry.outflow += within;
      if (transfer) {
        if (sign > 0) entry.transfersIn += within;
        else entry.transfersOut += within;
        entry.usd.transfers += sign * Number(row.tillOnly);
      } else {
        entry.usd.tillOnly += sign * Number(row.tillOnly);
      }
      entry.usd.cashCounted += sign * Number(row.cashCounted);
      entry.usd.cashEarly += sign * Number(row.cashEarly);
      entry.noUsdInPeriod += sign * Number(row.noUsd);
      entry.beforeOpeningInPeriod += Number(row.early);
      per.set(row.id, entry);
    }
  });

  const cents = (value: number) => Math.round(value * 100) / 100;
  return accounts.map((account) => {
    const entry = per.get(account.id) ?? empty();
    const count = Number(account.openingBalance);
    const date = account.openingDate;
    const opensBefore = date === null || date < from;
    const countedInPeriod = date !== null && date >= from && date <= to ? count : 0;
    const closesWith = date === null || date <= to;
    return {
      id: account.id,
      name: account.name,
      currency: account.currency,
      kind: account.kind,
      active: account.active,
      openingDate: date,
      opening: cents((opensBefore ? count : 0) + entry.opening),
      countedInPeriod: cents(countedInPeriod),
      inflow: cents(entry.inflow),
      outflow: cents(entry.outflow),
      transfersIn: cents(entry.transfersIn),
      transfersOut: cents(entry.transfersOut),
      closing: cents((closesWith ? count : 0) + entry.closing),
      beforeOpeningInPeriod: entry.beforeOpeningInPeriod,
      usd: entry.usd,
      noUsdInPeriod: entry.noUsdInPeriod,
    };
  });
}
