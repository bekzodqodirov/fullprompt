import { and, asc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  accountTransfers,
  clientTransactions,
  expenseCategories,
  expenses,
  moneyAccounts,
  partnerTransactions,
  recurringExpenses,
  users,
  warehouses,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { rateFor } from '../costing/service';

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
  const [row] = input.id
    ? await db
        .update(expenseCategories)
        .set(values)
        .where(eq(expenseCategories.id, input.id))
        .returning()
    : await db.insert(expenseCategories).values(values).returning();
  if (!row) throw new AccountingError('not_found');
  await writeAudit(db, ctx, {
    entityType: 'expense_category',
    entityId: row.id,
    action: input.id ? 'update' : 'create',
    after: values,
  });
  return row;
}

// --- Accounts ---------------------------------------------------------------

export const accountSchema = z.object({
  name: z.string().trim().min(2).max(120),
  currency: z.string().length(3).toUpperCase(),
  kind: z.enum(['cash', 'bank', 'card']),
  /** What was in the box before the system started (owner: "ha kiritamiz"). */
  openingBalance: z.number().min(-1_000_000_000).max(1_000_000_000).default(0),
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
  const [row] = input.id
    ? await db.update(moneyAccounts).set(values).where(eq(moneyAccounts.id, input.id)).returning()
    : await db.insert(moneyAccounts).values(values).returning();
  if (!row) throw new AccountingError('not_found');
  await writeAudit(db, ctx, {
    entityType: 'money_account',
    entityId: row.id,
    action: input.id ? 'update' : 'create',
    after: values,
  });
  return row;
}

// --- Expenses ---------------------------------------------------------------

export const expenseSchema = z.object({
  categoryId: z.string().uuid(),
  amount: z.number().positive().max(1_000_000_000),
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

export async function addExpense(input: ExpenseInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new AccountingError('unauthenticated');
  const rate = await rateFor(input.currency, input.expenseDate);
  if (rate === null) throw new AccountingError('fx_missing');
  const amountUsd = Math.round(input.amount * rate * 100) / 100;

  const [row] = await db
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
      createdBy: ctx.actorId,
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'expense',
    entityId: row!.id,
    action: 'create',
    after: { amount: input.amount, currency: input.currency, amountUsd, date: input.expenseDate },
  });
  if (input.partnerId) {
    const { chargeForExpense } = await import('../partners/link');
    await chargeForExpense(row!.id, ctx);
  }
  return row!;
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
  await writeAudit(db, ctx, {
    entityType: 'expense',
    entityId: id,
    action: 'void',
    before: { amountUsd: row.amountUsd },
    after: { reason: reason.trim() },
  });
}

export async function listExpenses(filters: {
  from?: string;
  to?: string;
  categoryId?: string;
  warehouseId?: string;
  limit?: number;
}) {
  const where = [isNull(expenses.voidedAt)];
  if (filters.from) where.push(gte(expenses.expenseDate, filters.from));
  if (filters.to) where.push(lte(expenses.expenseDate, filters.to));
  if (filters.categoryId) where.push(eq(expenses.categoryId, filters.categoryId));
  if (filters.warehouseId) where.push(eq(expenses.warehouseId, filters.warehouseId));
  return db
    .select({
      expense: expenses,
      categoryName: expenseCategories.name,
      warehouseCode: warehouses.code,
      employeeName: users.fullName,
      accountName: moneyAccounts.name,
    })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .leftJoin(warehouses, eq(expenses.warehouseId, warehouses.id))
    .leftJoin(users, eq(expenses.employeeId, users.id))
    .leftJoin(moneyAccounts, eq(expenses.accountId, moneyAccounts.id))
    .where(and(...where))
    .orderBy(sql`${expenses.expenseDate} DESC`, sql`${expenses.createdAt} DESC`)
    .limit(filters.limit ?? 500);
}

// --- Recurring (rent, salaries) ---------------------------------------------

export const recurringSchema = expenseSchema
  .omit({ expenseDate: true })
  .extend({ dayOfMonth: z.number().int().min(1).max(28).default(1), active: z.boolean().default(true) });

export async function listRecurring() {
  return db
    .select({
      recurring: recurringExpenses,
      categoryName: expenseCategories.name,
      employeeName: users.fullName,
    })
    .from(recurringExpenses)
    .innerJoin(expenseCategories, eq(recurringExpenses.categoryId, expenseCategories.id))
    .leftJoin(users, eq(recurringExpenses.employeeId, users.id))
    .orderBy(asc(expenseCategories.sortOrder));
}

export async function saveRecurring(
  input: z.infer<typeof recurringSchema> & { id?: string },
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new AccountingError('unauthenticated');
  const values = {
    categoryId: input.categoryId,
    amount: String(input.amount),
    currency: input.currency,
    dayOfMonth: input.dayOfMonth,
    warehouseId: input.warehouseId || null,
    employeeId: input.employeeId || null,
    accountId: input.accountId || null,
    note: input.note || null,
    active: input.active,
    createdBy: ctx.actorId,
  };
  const [row] = input.id
    ? await db
        .update(recurringExpenses)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(recurringExpenses.id, input.id))
        .returning()
    : await db.insert(recurringExpenses).values(values).returning();
  if (!row) throw new AccountingError('not_found');
  await writeAudit(db, ctx, {
    entityType: 'recurring_expense',
    entityId: row.id,
    action: input.id ? 'update' : 'create',
    after: { amount: input.amount, currency: input.currency, dayOfMonth: input.dayOfMonth },
  });
  return row;
}

/**
 * Post this month's fixed costs.
 *
 * A button, not a background job: a silent monthly insert would quietly
 * falsify the P&L of any month where the rent changed or someone left. The
 * accountant presses it and reviews what landed. Idempotent — a template that
 * already produced an expense for the month is skipped, so pressing twice
 * cannot double-charge.
 */
export async function generateRecurring(month: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new AccountingError('unauthenticated');
  if (!/^\d{4}-\d{2}$/.test(month)) throw new AccountingError('bad_month');
  const templates = await db
    .select()
    .from(recurringExpenses)
    .where(eq(recurringExpenses.active, true));

  let created = 0;
  const skipped: string[] = [];
  for (const template of templates) {
    const date = `${month}-${String(template.dayOfMonth).padStart(2, '0')}`;
    const existing = await db
      .select({ id: expenses.id })
      .from(expenses)
      .where(
        and(
          eq(expenses.categoryId, template.categoryId),
          eq(expenses.expenseDate, date),
          isNull(expenses.voidedAt),
          template.employeeId
            ? eq(expenses.employeeId, template.employeeId)
            : isNull(expenses.employeeId),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      skipped.push(template.id);
      continue;
    }
    await addExpense(
      {
        categoryId: template.categoryId,
        amount: Number(template.amount),
        currency: template.currency,
        expenseDate: date,
        warehouseId: template.warehouseId ?? '',
        employeeId: template.employeeId ?? '',
        accountId: template.accountId ?? '',
        note: template.note ?? '',
      },
      ctx,
    );
    created += 1;
  }
  return { created, skipped: skipped.length };
}

// --- Transfers between our own accounts -------------------------------------

export const transferSchema = z.object({
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  amountFrom: z.number().positive().max(1_000_000_000),
  amountTo: z.number().positive().max(1_000_000_000),
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
  const from = await db.query.moneyAccounts.findFirst({
    where: eq(moneyAccounts.id, input.fromAccountId),
  });
  if (!from) throw new AccountingError('not_found');
  const rate = await rateFor(from.currency, input.transferDate);
  if (rate === null) throw new AccountingError('fx_missing');

  const [row] = await db
    .insert(accountTransfers)
    .values({
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amountFrom: String(input.amountFrom),
      amountTo: String(input.amountTo),
      amountUsd: String(Math.round(input.amountFrom * rate * 100) / 100),
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

/**
 * Balance per account, in the account's OWN currency.
 *
 * Opening balance + client payments in − expenses out + transfers in −
 * transfers out. Deliberately native currency, not USD: this number is what
 * someone counts in the cash box, and converting it would make it impossible
 * to reconcile against the actual notes.
 */
export async function accountBalances() {
  const accounts = await listAccounts(true);
  const rows = await Promise.all(
    accounts.map(async (account) => {
      const [paid] = await db
        .select({ sum: sql<string>`coalesce(sum(${clientTransactions.amount}), 0)` })
        .from(clientTransactions)
        .where(
          and(
            eq(clientTransactions.accountId, account.id),
            eq(clientTransactions.type, 'payment'),
            isNull(clientTransactions.voidedAt),
          ),
        );
      const [spent] = await db
        .select({ sum: sql<string>`coalesce(sum(${expenses.amount}), 0)` })
        .from(expenses)
        .where(and(eq(expenses.accountId, account.id), isNull(expenses.voidedAt)));
      const [inbound] = await db
        .select({ sum: sql<string>`coalesce(sum(${accountTransfers.amountTo}), 0)` })
        .from(accountTransfers)
        .where(
          and(
            eq(accountTransfers.toAccountId, account.id),
            isNull(accountTransfers.voidedAt),
          ),
        );
      const [outbound] = await db
        .select({ sum: sql<string>`coalesce(sum(${accountTransfers.amountFrom}), 0)` })
        .from(accountTransfers)
        .where(
          and(
            eq(accountTransfers.fromAccountId, account.id),
            isNull(accountTransfers.voidedAt),
          ),
        );
      // Round 39: counterparty money moves the same boxes. A cash buyer
      // wiring som into the company account raises it; paying the transport
      // firm out of the till lowers it. Left out, every till this touched
      // would read wrong on the screen somebody counts notes against.
      const [partnerIn] = await db
        .select({ sum: sql<string>`coalesce(sum(${partnerTransactions.amount}), 0)` })
        .from(partnerTransactions)
        .where(
          and(
            eq(partnerTransactions.accountId, account.id),
            eq(partnerTransactions.type, 'receipt'),
            isNull(partnerTransactions.voidedAt),
          ),
        );
      const [partnerOut] = await db
        .select({ sum: sql<string>`coalesce(sum(${partnerTransactions.amount}), 0)` })
        .from(partnerTransactions)
        .where(
          and(
            eq(partnerTransactions.accountId, account.id),
            eq(partnerTransactions.type, 'payment'),
            isNull(partnerTransactions.voidedAt),
          ),
        );
      const balance =
        Number(account.openingBalance) +
        Number(paid?.sum ?? 0) -
        Number(spent?.sum ?? 0) +
        Number(inbound?.sum ?? 0) -
        Number(outbound?.sum ?? 0) +
        Number(partnerIn?.sum ?? 0) -
        Number(partnerOut?.sum ?? 0);
      return {
        id: account.id,
        name: account.name,
        currency: account.currency,
        kind: account.kind,
        active: account.active,
        opening: Number(account.openingBalance),
        paidIn: Number(paid?.sum ?? 0),
        spent: Number(spent?.sum ?? 0),
        transferredIn: Number(inbound?.sum ?? 0),
        transferredOut: Number(outbound?.sum ?? 0),
        balance: Math.round(balance * 100) / 100,
      };
    }),
  );
  return rows;
}
