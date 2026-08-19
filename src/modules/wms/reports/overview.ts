import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  batches,
  clientTransactions,
  expectedArrivals,
  leadStages,
  leads,
  receipts,
} from '../../platform/db/schema';

/**
 * The company on one screen (owner: "dashboard — butun tizim holati,
 * logistikadan moliyagacha, chiroyli va juda tushunarli").
 *
 * The old dashboard was a warehouse dashboard: stock, transit, unclaimed. It
 * never said whether the month made money or whether anyone was calling the
 * leads, which are the two things the owner opens a dashboard to find out.
 * Each block here is a separate function so a page can fetch only the ones
 * the viewer is allowed to see — an accountant's totals must not be computed
 * for a warehouse operator just to be thrown away.
 */

const money = (value: number) => Math.round(value * 100) / 100;

export interface TodaySnapshot {
  receipts: number;
  departed: number;
  arrived: number;
  expectedToday: number;
  expectedLate: number;
}

/** What has actually happened since midnight, plus what is still due. */
export async function todaySnapshot(warehouseIds?: string[]): Promise<TodaySnapshot> {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const today = new Date().toISOString().slice(0, 10);
  const whFilter = warehouseIds?.length ? warehouseIds : null;

  const [receiptRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(receipts)
    .where(
      and(
        eq(receipts.status, 'confirmed'),
        gte(receipts.receivedAt, midnight),
        whFilter ? inArray(receipts.warehouseId, whFilter) : undefined,
      ),
    );

  const [departedRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(batches)
    .where(
      and(
        gte(batches.departedAt, midnight),
        whFilter ? inArray(batches.originWarehouseId, whFilter) : undefined,
      ),
    );

  const [arrivedRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(batches)
    .where(
      and(
        gte(batches.arrivedAt, midnight),
        whFilter ? inArray(batches.destWarehouseId, whFilter) : undefined,
      ),
    );

  const [expectedRow] = await db
    .select({
      due: sql<number>`count(*) filter (where ${expectedArrivals.expectedOn} <= ${today})`,
      late: sql<number>`count(*) filter (where ${expectedArrivals.expectedOn} < ${today})`,
    })
    .from(expectedArrivals)
    .where(
      and(
        eq(expectedArrivals.status, 'waiting'),
        whFilter ? inArray(expectedArrivals.warehouseId, whFilter) : undefined,
      ),
    );

  return {
    receipts: Number(receiptRow?.n ?? 0),
    departed: Number(departedRow?.n ?? 0),
    arrived: Number(arrivedRow?.n ?? 0),
    expectedToday: Number(expectedRow?.due ?? 0),
    expectedLate: Number(expectedRow?.late ?? 0),
  };
}

export interface MoneySnapshot {
  /** Charged this month, in USD, at the rate frozen when it was charged. */
  revenueMonth: number;
  /** Received this month. */
  paidMonth: number;
  /** Everything still owed to us, whenever it was charged. */
  receivable: number;
  /** Of that, charged more than 60 days ago. */
  receivableOld: number;
  debtors: number;
  topDebtors: { clientId: string; clientCode: string; name: string; balance: number }[];
}

/**
 * The money half. Deliberately NOT the P&L: a dashboard tile that quietly
 * disagreed with the P&L page would be worse than no tile, so this reports
 * only figures that come straight off the ledger — charged, received, owed —
 * and links to the P&L for the rest.
 */
export async function moneySnapshot(): Promise<MoneySnapshot> {
  const now = new Date();
  const monthStart = `${now.toISOString().slice(0, 7)}-01`;
  const today = now.toISOString().slice(0, 10);
  const sixtyDaysAgo = new Date(now);
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const oldCutoff = sixtyDaysAgo.toISOString().slice(0, 10);

  const [monthRow] = await db
    .select({
      revenue: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) filter (where ${clientTransactions.type} = 'charge'), 0)`,
      paid: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) filter (where ${clientTransactions.type} = 'payment'), 0)`,
    })
    .from(clientTransactions)
    .where(
      and(
        isNull(clientTransactions.voidedAt),
        gte(clientTransactions.txDate, monthStart),
        lte(clientTransactions.txDate, today),
      ),
    );

  // Per-client balances, so "how many owe us" is a count of people and not a
  // count of invoices.
  const balances = await db
    .select({
      clientId: clientTransactions.clientId,
      balance: sql<string>`sum(CASE WHEN ${clientTransactions.type} = 'charge' THEN ${clientTransactions.amountUsd} ELSE -${clientTransactions.amountUsd} END)`,
      oldCharges: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) filter (where ${clientTransactions.type} = 'charge' AND ${clientTransactions.txDate} < ${oldCutoff}), 0)`,
      paid: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) filter (where ${clientTransactions.type} = 'payment'), 0)`,
    })
    .from(clientTransactions)
    .where(isNull(clientTransactions.voidedAt))
    .groupBy(clientTransactions.clientId);

  let receivable = 0;
  let receivableOld = 0;
  let debtors = 0;
  for (const row of balances) {
    const balance = Number(row.balance);
    if (balance <= 0.004) continue;
    debtors += 1;
    receivable += balance;
    // Payments settle the oldest charge first (DECISIONS #146), so what is
    // left of the old charges after applying every payment is the old debt.
    receivableOld += Math.max(0, Math.min(balance, Number(row.oldCharges) - Number(row.paid)));
  }

  const top = await db
    .select({
      clientId: clientTransactions.clientId,
      clientCode: sql<string>`(SELECT c.client_code FROM clients c WHERE c.id = ${clientTransactions.clientId})`,
      name: sql<string>`(SELECT c.name FROM clients c WHERE c.id = ${clientTransactions.clientId})`,
      balance: sql<string>`sum(CASE WHEN ${clientTransactions.type} = 'charge' THEN ${clientTransactions.amountUsd} ELSE -${clientTransactions.amountUsd} END)`,
    })
    .from(clientTransactions)
    .where(isNull(clientTransactions.voidedAt))
    .groupBy(clientTransactions.clientId)
    .having(
      sql`sum(CASE WHEN ${clientTransactions.type} = 'charge' THEN ${clientTransactions.amountUsd} ELSE -${clientTransactions.amountUsd} END) > 0.004`,
    )
    .orderBy(
      sql`sum(CASE WHEN ${clientTransactions.type} = 'charge' THEN ${clientTransactions.amountUsd} ELSE -${clientTransactions.amountUsd} END) DESC`,
    )
    .limit(5);

  return {
    revenueMonth: money(Number(monthRow?.revenue ?? 0)),
    paidMonth: money(Number(monthRow?.paid ?? 0)),
    receivable: money(receivable),
    receivableOld: money(receivableOld),
    debtors,
    topDebtors: top.map((row) => ({
      clientId: row.clientId,
      clientCode: row.clientCode,
      name: row.name,
      balance: money(Number(row.balance)),
    })),
  };
}

export interface SalesSnapshot {
  open: number;
  wonMonth: number;
  lostMonth: number;
  /** Follow-ups due today or already overdue, leads only. */
  dueToday: number;
  byStage: { name: string; kind: string; color: string; n: number }[];
}

/** The funnel, in the shape the board shows it. */
export async function salesSnapshot(ownerId?: string): Promise<SalesSnapshot> {
  const now = new Date();
  // Bound as an ISO string with an explicit cast: a Date interpolated
  // into a raw sql fragment reaches the driver untyped and it refuses it.
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const today = now.toISOString().slice(0, 10);
  const mine = ownerId ? eq(leads.ownerId, ownerId) : undefined;

  const rows = await db
    .select({
      name: leadStages.name,
      kind: leadStages.kind,
      color: leadStages.color,
      sortOrder: leadStages.sortOrder,
      n: sql<number>`count(${leads.id})`,
      // Won and lost are counted for the MONTH — a lifetime "lost" column
      // grows for ever and stops meaning anything. By the DECISION clock
      // (`closed_at`, round 98): `updated_at` counted a won lead merely
      // re-touched this month as won again, so /dashboard and the admin
      // home's decided cells printed two different «bu oy yutilgan» for the
      // same month (round 107 — #513 across screens).
      recent: sql<number>`count(${leads.id}) filter (where ${leads.closedAt} >= ${monthStart}::timestamptz)`,
    })
    .from(leadStages)
    .leftJoin(leads, and(eq(leads.stageId, leadStages.id), mine))
    .where(eq(leadStages.active, true))
    .groupBy(leadStages.id, leadStages.name, leadStages.kind, leadStages.color, leadStages.sortOrder)
    .orderBy(leadStages.sortOrder);

  const [dueRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(leads)
    .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
    .where(
      and(
        eq(leadStages.kind, 'open'),
        lte(leads.nextActionAt, today),
        mine,
      ),
    );

  return {
    open: rows.filter((r) => r.kind === 'open').reduce((a, r) => a + Number(r.n), 0),
    wonMonth: rows.filter((r) => r.kind === 'won').reduce((a, r) => a + Number(r.recent), 0),
    lostMonth: rows.filter((r) => r.kind === 'lost').reduce((a, r) => a + Number(r.recent), 0),
    dueToday: Number(dueRow?.n ?? 0),
    byStage: rows
      .filter((r) => r.kind === 'open')
      .map((r) => ({ name: r.name, kind: r.kind, color: r.color, n: Number(r.n) })),
  };
}
