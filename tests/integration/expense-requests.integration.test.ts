import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  events,
  expenseCategories,
  expenseRequests,
  expenses,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import {
  claimExpenseRequest,
  finishExpenseRequest,
  myExpenseRequests,
  openExpenseRequests,
  rejectExpenseRequest,
  releaseExpenseRequest,
  requestExpense,
} from '@/modules/wms/accounting/expense-requests';
import { addExpense, voidExpense } from '@/modules/wms/accounting/service';
import { renderTelegramText } from '@/modules/platform/notifications/service';

/**
 * Rasxod xabari (round 107, item 5): the operator reports, finance enters,
 * and between the two sits a CLAIM — the double-entry race is the common
 * case (two accountants, one open panel), and «one Kiritish wins» is the
 * whole design.
 */

const SUFFIX = String(Date.now()).slice(-6);
let actorId: string;
let whId: string;
let categoryId: string;
const madeRequests: string[] = [];
const madeExpenses: string[] = [];
const ctx = () => ({ actorId });

async function mintRequest(over: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  await requestExpense(
    {
      id,
      warehouseId: whId,
      amount: 120,
      currency: 'USD',
      note: `mix ${SUFFIX}`,
      ...over,
    } as Parameters<typeof requestExpense>[0],
    ctx(),
  );
  madeRequests.push(id);
  return id;
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  whId = (
    await db
      .insert(warehouses)
      .values({
        code: `ZR${SUFFIX}`,
        name: `Rasxod sklad ${SUFFIX}`,
        country: 'CN',
        type: 'origin',
        timezone: 'Asia/Shanghai',
        batchPrefix: `ZR${SUFFIX}`,
      })
      .returning({ id: warehouses.id })
  )[0]!.id;
  categoryId = (
    await db
      .insert(expenseCategories)
      .values({ name: `Rasxod turi ${SUFFIX}` })
      .returning({ id: expenseCategories.id })
  )[0]!.id;
});

afterAll(async () => {
  if (madeRequests.length) {
    await db.delete(events).where(inArray(events.entityId, madeRequests));
    await db.delete(expenseRequests).where(inArray(expenseRequests.id, madeRequests));
  }
  if (madeExpenses.length) {
    await db.delete(events).where(inArray(events.entityId, madeExpenses));
    await db.delete(expenses).where(inArray(expenses.id, madeExpenses));
  }
  await db.delete(expenseCategories).where(eq(expenseCategories.id, categoryId));
  // Deactivated, not deleted: the audit trail stamps this warehouse and
  // audit_log refuses deletes by database rule — inactive is how a warehouse
  // leaves every picker (#183) without fighting the trail.
  await db.update(warehouses).set({ active: false }).where(eq(warehouses.id, whId));
  await pgClient.end();
});

describe('the report', () => {
  it('lands once, with the event that pings finance, however many times the button fires', async () => {
    const id = await mintRequest();
    // A double tap replays the client-minted id — one row, not two.
    await requestExpense(
      { id, warehouseId: whId, amount: 120, currency: 'USD', note: `mix ${SUFFIX}` },
      ctx(),
    );
    const rows = await db.select().from(expenseRequests).where(eq(expenseRequests.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('open');
    const eventRows = await db.select().from(events).where(eq(events.entityId, id));
    expect(eventRows.filter((row) => row.type === 'ExpenseRequested')).toHaveLength(1);
    // …and the operator's own fold sees it.
    const mine = await myExpenseRequests(actorId);
    expect(mine.some((row) => row.id === id)).toBe(true);
  });

  it('refuses an unknown warehouse', async () => {
    await expect(
      requestExpense(
        {
          id: crypto.randomUUID(),
          warehouseId: crypto.randomUUID(),
          amount: 10,
          currency: 'USD',
          note: 'yolgon sklad',
        },
        ctx(),
      ),
    ).rejects.toThrow('warehouse_not_found');
  });

  it('the two Telegram texts say what happened, in the reader’s language', () => {
    const requested = renderTelegramText(
      'ExpenseRequested',
      {
        warehouseCode: 'YW',
        requesterName: 'Skladchi',
        amount: '120.00',
        currency: 'USD',
        note: 'mix',
      },
      'uz',
    );
    expect(requested).toContain('kiritish kerak');
    expect(requested).toContain('/accounting/expenses');
    const rejected = renderTelegramText(
      'ExpenseRequestDecided',
      { verdict: 'rejected', amount: '120.00', currency: 'USD', note: 'mix', rejectReason: 'chek yo‘q' },
      'uz',
    );
    expect(rejected).toContain('rad etildi');
    expect(rejected).toContain('chek yo‘q');
  });
});

describe('the claim — one «Kiritish» wins', () => {
  it('a second claim answers already_decided, and release puts it back', async () => {
    const id = await mintRequest();
    const claimed = await claimExpenseRequest(id, ctx());
    expect(claimed.status).toBe('done');
    await expect(claimExpenseRequest(id, ctx())).rejects.toThrow('already_decided');
    // The expense was refused → the claim goes back.
    await releaseExpenseRequest(id);
    const row = (await db.select().from(expenseRequests).where(eq(expenseRequests.id, id)))[0]!;
    expect(row.status).toBe('open');
    expect(row.decidedBy).toBeNull();
  });

  it('a claimed row whose expense never landed stays VISIBLE on the queue', async () => {
    const id = await mintRequest();
    await claimExpenseRequest(id, ctx());
    const queue = await openExpenseRequests();
    const row = queue.find((entry) => entry.id === id);
    expect(row, 'done-with-nothing must not vanish').toBeDefined();
    expect(row!.status).toBe('done');
    await releaseExpenseRequest(id);
  });

  it('rejection demands a reason, answers the reporter, and is single-shot', async () => {
    const id = await mintRequest();
    await expect(rejectExpenseRequest(id, ' ', ctx())).rejects.toThrow('reason_required');
    await rejectExpenseRequest(id, 'chek yo‘q', ctx());
    const row = (await db.select().from(expenseRequests).where(eq(expenseRequests.id, id)))[0]!;
    expect(row.status).toBe('rejected');
    expect(row.rejectReason).toBe('chek yo‘q');
    const decided = (await db.select().from(events).where(eq(events.entityId, id))).filter(
      (event) => event.type === 'ExpenseRequestDecided',
    );
    expect(decided).toHaveLength(1);
    expect((decided[0]!.payload as Record<string, unknown>).requestedBy).toBe(actorId);
    await expect(rejectExpenseRequest(id, 'ikkinchi marta', ctx())).rejects.toThrow(
      'already_decided',
    );
  });
});

describe('the pair rule — voiding the expense re-opens the report', () => {
  it('a voided expense must not leave «kiritildi» standing (#528)', async () => {
    const id = await mintRequest();
    await claimExpenseRequest(id, ctx());
    const expense = await addExpense(
      {
        categoryId,
        amount: 120,
        currency: 'USD',
        expenseDate: new Date().toISOString().slice(0, 10),
        warehouseId: whId,
      } as Parameters<typeof addExpense>[0],
      ctx(),
    );
    madeExpenses.push(expense.id);
    await finishExpenseRequest(id, expense.id, ctx());
    const done = (await db.select().from(expenseRequests).where(eq(expenseRequests.id, id)))[0]!;
    expect(done.status).toBe('done');
    expect(done.expenseId).toBe(expense.id);

    await voidExpense(expense.id, 'xato kiritildi', ctx());
    const reopened = (
      await db.select().from(expenseRequests).where(eq(expenseRequests.id, id))
    )[0]!;
    expect(reopened.status).toBe('open');
    expect(reopened.expenseId).toBeNull();
  });
});
