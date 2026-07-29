import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  clients,
  clientTransactions,
  dealStages,
  deals,
  expenseCategories,
  expenses,
  leadStages,
  leads,
  loadPlans,
  recurringExpenses,
  tgMessages,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import {
  logistFlowCounts,
  moneyFlowCounts,
  salesFlowCounts,
} from '@/modules/wms/home/role-flows';

/**
 * The three new role homes against a real database. Deltas, never absolutes:
 * the whole suite shares this database, so every count is asked before and
 * after the one row this test controls. Each case is the predicate that
 * would silently lie without its filter — a won-stage lead, a voided
 * payment, an already-posted recurring template.
 */

const STAMP = Date.now();
const TODAY = new Date().toISOString().slice(0, 10);

let managerId: string;
let clientId: string;
let openStageId: string;
let wonLeadStageId: string | null;
let openDealStageId: string;
let whId: string;
const madeLeads: string[] = [];
const madeDeals: string[] = [];
const madePlans: string[] = [];

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({
      phone: `+99893${String(STAMP).slice(-7)}`,
      fullName: `Role home ${STAMP}`,
      passwordHash: 'x',
      active: true,
    })
    .returning({ id: users.id });
  managerId = user!.id;

  const [client] = await db
    .insert(clients)
    .values({
      clientCode: `RH${STAMP}`.slice(0, 12),
      name: `Role home client ${STAMP}`,
      salesManagerId: managerId,
    })
    .returning({ id: clients.id });
  clientId = client!.id;

  const stages = await db.select().from(leadStages);
  openStageId = stages.find((s) => s.kind === 'open')!.id;
  wonLeadStageId = stages.find((s) => s.kind === 'won')?.id ?? null;
  const dstages = await db.select().from(dealStages);
  openDealStageId = dstages.find((s) => s.kind === 'open')!.id;

  whId = (await db.select().from(warehouses).limit(1))[0]!.id;
});

afterAll(async () => {
  if (madePlans.length) await db.delete(loadPlans).where(inArray(loadPlans.id, madePlans));
  if (madeDeals.length) await db.delete(deals).where(inArray(deals.id, madeDeals));
  if (madeLeads.length) await db.delete(leads).where(inArray(leads.id, madeLeads));
  await db.delete(tgMessages).where(eq(tgMessages.clientId, clientId));
  await db.delete(clientTransactions).where(eq(clientTransactions.clientId, clientId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await db.delete(users).where(eq(users.id, managerId));
  await pgClient.end();
});

describe('the sales home', () => {
  it('counts the manager’s own day: calls, leads, debtors, deals', async () => {
    const before = await salesFlowCounts(managerId, TODAY);

    // A lead due YESTERDAY is both a call and an overdue one; a lead in a
    // won stage must count for nothing.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const [dueLead] = await db
      .insert(leads)
      .values({
        name: `RH due ${STAMP}`,
        stageId: openStageId,
        ownerId: managerId,
        nextActionAt: yesterday,
        createdBy: managerId,
      })
      .returning({ id: leads.id });
    madeLeads.push(dueLead!.id);
    if (wonLeadStageId) {
      const [won] = await db
        .insert(leads)
        .values({
          name: `RH won ${STAMP}`,
          stageId: wonLeadStageId,
          ownerId: managerId,
          createdBy: managerId,
        })
        .returning({ id: leads.id });
      madeLeads.push(won!.id);
    }

    // A charge makes the client a debtor; the payment un-makes him.
    await db.insert(clientTransactions).values({
      clientId,
      type: 'charge',
      amount: '100',
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: '100',
      txDate: TODAY,
      createdBy: managerId,
    });

    // An open deal counts; a deal is not a lead and vice versa.
    const [deal] = await db
      .insert(deals)
      .values({
        code: `B-RH${String(STAMP).slice(-8)}`,
        clientId,
        stageId: openDealStageId,
        ownerId: managerId,
        createdBy: managerId,
      })
      .returning({ id: deals.id });
    madeDeals.push(deal!.id);

    const withData = await salesFlowCounts(managerId, TODAY);
    expect(withData.callsDue).toBe(before.callsDue + 1);
    expect(withData.callsOverdue).toBe(before.callsOverdue + 1);
    expect(withData.openLeads).toBe(before.openLeads + 1); // the won lead is invisible
    expect(withData.debtors).toBe(before.debtors + 1);
    expect(withData.openDeals).toBe(before.openDeals + 1);

    await db.insert(clientTransactions).values({
      clientId,
      type: 'payment',
      amount: '100',
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: '100',
      txDate: TODAY,
      method: 'cash',
      createdBy: managerId,
    });
    expect((await salesFlowCounts(managerId, TODAY)).debtors).toBe(before.debtors);

    // Another manager sees none of it — the scope is the whole point.
    const stranger = await salesFlowCounts(clientId /* any uuid that owns nothing */, TODAY);
    expect(stranger.callsDue).toBe(0);
  });

  it('a conversation waits on us only while the LAST word is the client’s', async () => {
    const before = await salesFlowCounts(managerId, TODAY);
    await db.insert(tgMessages).values({
      clientId,
      managerUserId: managerId,
      peerId: BigInt(STAMP),
      tgMessageId: 1n,
      direction: 'in',
      body: 'Yuk qayerda?',
      sentAt: new Date(Date.now() - 60_000),
    });
    expect((await salesFlowCounts(managerId, TODAY)).waitingChats).toBe(before.waitingChats + 1);

    // The reply flips the thread out of the waiting count.
    await db.insert(tgMessages).values({
      clientId,
      managerUserId: managerId,
      peerId: BigInt(STAMP),
      tgMessageId: 2n,
      direction: 'out',
      body: 'Ertaga yetadi',
      sentAt: new Date(),
    });
    expect((await salesFlowCounts(managerId, TODAY)).waitingChats).toBe(before.waitingChats);
  });
});

describe('the logist home', () => {
  it('counts only the plans that wait on a verdict', async () => {
    const unscoped = { warehouseScoped: false, warehouseIds: [] };
    const before = await logistFlowCounts(unscoped, TODAY);

    const [pending] = await db
      .insert(loadPlans)
      .values({
        originWarehouseId: whId,
        destWarehouseId: whId,
        status: 'pending_agent',
        createdBy: managerId,
      })
      .returning({ id: loadPlans.id });
    madePlans.push(pending!.id);

    const withPlan = await logistFlowCounts(unscoped, TODAY);
    expect(withPlan.plansPending).toBe(before.plansPending + 1);

    // A verdict removes it from the queue — an approved plan is not waiting.
    await db.update(loadPlans).set({ status: 'approved' }).where(eq(loadPlans.id, pending!.id));
    expect((await logistFlowCounts(unscoped, TODAY)).plansPending).toBe(before.plansPending);
  });
});

describe('the accountant home', () => {
  it('an unplaced payment counts only while live, unplaced and this month', async () => {
    const before = await moneyFlowCounts(TODAY);

    const [tx] = await db
      .insert(clientTransactions)
      .values({
        clientId,
        type: 'payment',
        amount: '50',
        currency: 'USD',
        rateToUsd: '1',
        amountUsd: '50',
        txDate: TODAY,
        method: 'cash',
        createdBy: managerId,
      })
      .returning({ id: clientTransactions.id });
    expect((await moneyFlowCounts(TODAY)).unassignedPayments).toBe(before.unassignedPayments + 1);

    // Voided → out of the count: an undone payment needs no placing.
    await db
      .update(clientTransactions)
      .set({ voidedAt: new Date(), voidedBy: managerId, voidReason: 'sinov' })
      .where(eq(clientTransactions.id, tx!.id));
    expect((await moneyFlowCounts(TODAY)).unassignedPayments).toBe(before.unassignedPayments);
  });

  it('a recurring template is due only until its month is posted', async () => {
    const before = await moneyFlowCounts(TODAY);

    const [category] = await db
      .insert(expenseCategories)
      .values({ name: `RH ijara ${STAMP}`, cash: true, sortOrder: 999 })
      .returning({ id: expenseCategories.id });
    const [template] = await db
      .insert(recurringExpenses)
      .values({
        categoryId: category!.id,
        amount: '700',
        currency: 'USD',
        dayOfMonth: 5,
        createdBy: managerId,
      })
      .returning({ id: recurringExpenses.id, dayOfMonth: recurringExpenses.dayOfMonth });
    expect((await moneyFlowCounts(TODAY)).recurringDue).toBe(before.recurringDue + 1);

    // The posted expense — same category, same slot date, no employee —
    // is exactly generateRecurring's own idempotence predicate.
    const slotDate = `${TODAY.slice(0, 7)}-05`;
    const [posted] = await db
      .insert(expenses)
      .values({
        categoryId: category!.id,
        amount: '700',
        currency: 'USD',
        rateToUsd: '1',
        amountUsd: '700',
        expenseDate: slotDate,
        createdBy: managerId,
      })
      .returning({ id: expenses.id });
    expect((await moneyFlowCounts(TODAY)).recurringDue).toBe(before.recurringDue);

    // A VOIDED posting does not satisfy the month — the template is due again.
    await db
      .update(expenses)
      .set({ voidedAt: new Date(), voidedBy: managerId, voidReason: 'sinov' })
      .where(eq(expenses.id, posted!.id));
    expect((await moneyFlowCounts(TODAY)).recurringDue).toBe(before.recurringDue + 1);

    await db.delete(expenses).where(eq(expenses.id, posted!.id));
    await db.delete(recurringExpenses).where(eq(recurringExpenses.id, template!.id));
    await db
      .delete(expenseCategories)
      .where(and(eq(expenseCategories.id, category!.id)));
  });
});
