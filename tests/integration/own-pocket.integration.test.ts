import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  events,
  expenseCategories,
  expenseRequests,
  expenses,
  moneyAccounts,
  partners,
  partnerTransactions,
  partnerTypes,
  users,
} from '@/modules/platform/db/schema';
import {
  claimExpenseRequest,
  finishExpenseRequest,
  openExpenseRequests,
  requestExpense,
} from '@/modules/wms/accounting/expense-requests';
import { addExpense } from '@/modules/wms/accounting/service';
import { addPartnerTx } from '@/modules/wms/partners/service';
import { openStaffPartner, staffAccountView } from '@/modules/wms/partners/staff-account';
import { renderTelegramText } from '@/modules/platform/notifications/service';

/**
 * «O'z pulimdan to'ladim» (owner M1a) and «Kompaniya bilan hisob-kitobim»
 * (A2a): a seller who belongs to no warehouse reports a taxi paid out of
 * pocket, the accountant's «Kiritish» books it as a debt to the seller's
 * staff account, an advance turns the balance round, and the seller's own
 * /profile says which way it stands — in their words.
 *
 * Dates live in the accounting suite's private past (1700s), so no period
 * report in another file ever counts this money.
 */

const SUFFIX = String(Date.now()).slice(-7);
const DAY = '1716-05-10';
let adminId: string;
let reporterId: string;
let strangerId: string;
let elsewhereId: string;
let categoryId: string;
let tillId: string;
const madeUsers: string[] = [];
const madeRequests: string[] = [];
const madeExpenses: string[] = [];
const madePartners: string[] = [];
const ctx = () => ({ actorId: adminId });

async function mintUser(tag: string) {
  const [row] = await db
    .insert(users)
    .values({
      phone: `+99897${SUFFIX}${madeUsers.length}`,
      fullName: `OP ${tag} ${SUFFIX}`,
      passwordHash: 'x',
      active: true,
    })
    .returning({ id: users.id });
  madeUsers.push(row!.id);
  return row!.id;
}

async function fileRequest(over: Partial<Parameters<typeof requestExpense>[0]> = {}) {
  const id = crypto.randomUUID();
  await requestExpense(
    { id, amount: 120, currency: 'USD', note: `taksi ${SUFFIX}`, paidBySelf: true, ...over },
    { actorId: reporterId },
  );
  madeRequests.push(id);
  return id;
}

beforeAll(async () => {
  adminId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  reporterId = await mintUser('seller');
  strangerId = await mintUser('nobody');
  elsewhereId = await mintUser('linked-elsewhere');
  categoryId = (
    await db
      .insert(expenseCategories)
      .values({ name: `O'z puli ${SUFFIX}` })
      .returning({ id: expenseCategories.id })
  )[0]!.id;
  tillId = (
    await db
      .insert(moneyAccounts)
      .values({ name: `OP kassa ${SUFFIX}`, currency: 'USD', kind: 'cash', sortOrder: 953 })
      .returning({ id: moneyAccounts.id })
  )[0]!.id;
});

afterAll(async () => {
  if (madePartners.length) {
    await db.delete(partnerTransactions).where(inArray(partnerTransactions.partnerId, madePartners));
  }
  if (madeRequests.length) {
    await db.delete(events).where(inArray(events.entityId, madeRequests));
    await db.delete(expenseRequests).where(inArray(expenseRequests.id, madeRequests));
  }
  if (madeExpenses.length) {
    await db.delete(events).where(inArray(events.entityId, madeExpenses));
    await db.delete(expenses).where(inArray(expenses.id, madeExpenses));
  }
  if (madePartners.length) await db.delete(partners).where(inArray(partners.id, madePartners));
  if (tillId) await db.delete(moneyAccounts).where(eq(moneyAccounts.id, tillId));
  if (categoryId) await db.delete(expenseCategories).where(eq(expenseCategories.id, categoryId));
  // Deactivated, never deleted: audit_log names these people and refuses
  // deletes by database rule.
  if (madeUsers.length) {
    await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
  }
  await pgClient.end();
});

describe('the report with no warehouse', () => {
  it('is filed, pings finance, and stands on the queue with its reporter and «o‘z pulidan»', async () => {
    const id = await fileRequest();
    const [row] = await db.select().from(expenseRequests).where(eq(expenseRequests.id, id));
    expect(row!.warehouseId).toBeNull();
    expect(row!.paidBySelf).toBe(true);

    // The queue LEFT-joins the warehouse: an inner join dropped this row, and
    // the only screen that can answer the reporter never saw it.
    const queued = (await openExpenseRequests()).find((entry) => entry.id === id);
    expect(queued, 'a warehouse-less report must reach the queue').toBeDefined();
    expect(queued!.paidBySelf).toBe(true);
    expect(queued!.createdBy).toBe(reporterId);
    expect(queued!.requesterName).toBe(`OP seller ${SUFFIX}`);
    expect(queued!.warehouseCode).toBeNull();

    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.entityId, id));
    const payload = event!.payload as Record<string, unknown>;
    expect(payload.warehouseCode).toBeNull();
    const text = renderTelegramText('ExpenseRequested', payload, 'uz');
    expect(text).not.toContain('null');
    expect(text).toContain('o‘z pulidan');
    expect(text).toContain('/accounting/expenses');
  });
});

describe('«Hodim kontragentini ochish»', () => {
  it('mints ONE staff account per login, however many times it is pressed', async () => {
    const first = await openStaffPartner(reporterId, ctx());
    madePartners.push(first.id);
    expect(first.created).toBe(true);
    const second = await openStaffPartner(reporterId, ctx());
    expect(second).toEqual({ id: first.id, created: false });
    const rows = await db.select().from(partners).where(eq(partners.userId, reporterId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe(`OP seller ${SUFFIX}`);
    const [type] = await db.select().from(partnerTypes).where(eq(partnerTypes.id, rows[0]!.typeId));
    expect(type!.code).toBe('staff');
  });

  it('refuses a login already tied to a counterparty that is not a staff account', async () => {
    const [other] = await db
      .select({ id: partnerTypes.id })
      .from(partnerTypes)
      .where(eq(partnerTypes.code, 'transport'))
      .limit(1);
    expect(other, 'the seed ships a transport type').toBeDefined();
    const [firm] = await db
      .insert(partners)
      .values({ name: `OP firma ${SUFFIX}`, typeId: other!.id, userId: elsewhereId, createdBy: adminId })
      .returning({ id: partners.id });
    madePartners.push(firm!.id);
    await expect(openStaffPartner(elsewhereId, ctx())).rejects.toThrow('user_linked_elsewhere');
    const rows = await db.select().from(partners).where(eq(partners.userId, elsewhereId));
    expect(rows.map((row) => row.id)).toEqual([firm!.id]);
  });
});

describe('the profile panel', () => {
  it('says nothing to somebody who has never spent their own money', async () => {
    expect(await staffAccountView(strangerId)).toBeNull();
  });

  it('turns from «not yet» to «the company owes you» to «advance left»', async () => {
    const id = await fileRequest({ amount: 80, note: `kuryer ${SUFFIX}` });
    const before = await staffAccountView(reporterId);
    expect(before, 'an open own-pocket report shows the panel').not.toBeNull();
    expect(before!.pending.map((row) => row.id)).toContain(id);

    // «Kiritish» with the reporter's staff account as the payer — what the
    // page pre-selects for an own-pocket report.
    const staff = (await db.select().from(partners).where(eq(partners.userId, reporterId)))[0]!;
    await claimExpenseRequest(id, ctx());
    const expense = await addExpense(
      {
        categoryId,
        amount: 80,
        currency: 'USD',
        expenseDate: DAY,
        partnerId: staff.id,
        note: `kuryer ${SUFFIX}`,
      },
      ctx(),
    );
    madeExpenses.push(expense.id);
    await finishExpenseRequest(id, expense.id, ctx());

    const owed = (await staffAccountView(reporterId))!;
    expect(owed.headline).toBe('company_owes');
    expect(owed.amountUsd).toBe(80);
    expect(owed.pending.map((row) => row.id)).not.toContain(id);
    expect(owed.rows[0]).toMatchObject({ kind: 'charge', amount: 80, currency: 'USD', raises: true });
    expect(owed.perCurrency).toEqual([{ currency: 'USD', amount: 80 }]);

    // A cash advance bigger than the debt: the person now holds company money.
    await addPartnerTx(
      {
        partnerId: staff.id,
        type: 'payment',
        amount: 200,
        currency: 'USD',
        txDate: DAY,
        accountId: tillId,
        note: `avans ${SUFFIX}`,
      },
      ctx(),
    );
    const advance = (await staffAccountView(reporterId))!;
    expect(advance.headline).toBe('advance_left');
    expect(advance.amountUsd).toBe(120);
    expect(advance.perCurrency).toEqual([{ currency: 'USD', amount: -120 }]);
    expect(advance.rows.map((row) => row.kind).sort()).toEqual(['charge', 'payment']);
  });
});
