import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  batches,
  calcRequests,
  clientTransactions,
  dealStages,
  deals,
  loadPlans,
} from '../../platform/db/schema';
import type { ScopedActor } from '../../platform/rbac/scope';
import { followUps, openLeadCount } from '../crm/service';
import { managedClients } from '../finance/client-cargo';
import { moneySnapshot, type MoneySnapshot } from '../reports/overview';
import { costMissingBatches } from '../reports/queries';
import { warehouseFlowCounts, type WarehouseFlowCounts } from './flow';

/**
 * The other three workflow homes (owner: "har bir hodim qiladigan ishiga
 * qarab layout tuz", round 11 started with the skladchi; this round finishes
 * the set). Same contract as `flow.ts`: the home screen is the most-opened
 * page in the app, so every number here is either an indexed count or a
 * query its own screen already pays for on every open.
 *
 * Who gets which home is decided in ONE place, `buildHomeFlow`, ordered from
 * the narrowest job to the broadest — the same rule the tab bar uses
 * (PRIMARY_BY_ROLE, nav.ts). Warehouse scope wins outright because scope is
 * a fact about the DATA, not just the menu: a sales manager who is also a
 * warehouse operator lives the warehouse day.
 */

export interface SalesFlowCounts {
  /** Follow-ups due today or overdue — the morning screen's list. */
  callsDue: number;
  callsOverdue: number;
  openLeads: number;
  /** Conversations whose LAST message is the client's — waiting on us. */
  waitingChats: number;
  /** Own clients currently owing money. */
  debtors: number;
  openDeals: number;
}

export async function salesFlowCounts(actorId: string, today: string): Promise<SalesFlowCounts> {
  const [calls, openLeads, waiting, book, openDealRows] = await Promise.all([
    followUps(today, actorId),
    openLeadCount(actorId),
    // The same DISTINCT ON walk `listConversations` does, reduced to one
    // number: how many of THIS manager's own threads end with the client's
    // word — the same rows their /suhbatlar screen shows, and no one else's
    // (a colleague's personal Telegram is not this person's morning list).
    db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM (
        SELECT DISTINCT ON (client_id) direction
        FROM tg_messages
        WHERE manager_user_id = ${actorId}
        ORDER BY client_id, sent_at DESC
      ) t WHERE t.direction = 'in'
    `),
    managedClients(actorId),
    db
      .select({ n: sql<number>`count(*)` })
      .from(deals)
      .innerJoin(dealStages, eq(deals.stageId, dealStages.id))
      .where(and(eq(deals.ownerId, actorId), eq(dealStages.kind, 'open'))),
  ]);
  return {
    callsDue: calls.length,
    callsOverdue: calls.filter((call) => call.dueOn < today).length,
    openLeads,
    waitingChats: Number(waiting[0]?.n ?? 0),
    // The same 0.009 line the my-clients screen draws.
    debtors: book.filter((client) => client.balanceUsd > 0.009).length,
    openDeals: Number(openDealRows[0]?.n ?? 0),
  };
}

export interface LogistFlowCounts {
  /** Plans waiting on a verdict — the logist's unique queue. */
  plansPending: number;
  /** Company-wide warehouse day: the logist is unscoped on purpose. */
  warehouse: WarehouseFlowCounts;
  /** Departed >3 days with not a single cost entry. */
  costMissing: number;
}

export async function logistFlowCounts(
  actor: ScopedActor,
  today: string,
): Promise<LogistFlowCounts> {
  const [plans, warehouse, costMissing] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)` })
      .from(loadPlans)
      .where(inArray(loadPlans.status, ['pending_agent', 'changes_requested'])),
    // Unscoped actor → company-wide counts, exactly what a logist watches.
    warehouseFlowCounts(actor, today),
    costMissingBatches(3),
  ]);
  return {
    plansPending: Number(plans[0]?.n ?? 0),
    warehouse,
    costMissing: costMissing.length,
  };
}

export interface MoneyFlowCounts {
  snapshot: MoneySnapshot;
  /** THIS month's payments with no cash box — bounded so the years of
   *  pre-accounts history don't drown the actionable few. */
  unassignedPayments: number;
  /** Active recurring templates not yet posted this month. */
  recurringDue: number;
  costMissing: number;
}

export async function moneyFlowCounts(today: string): Promise<MoneyFlowCounts> {
  const month = today.slice(0, 7);
  const [snapshot, unassigned, recurring, costMissing] = await Promise.all([
    moneySnapshot(),
    db
      .select({ n: sql<number>`count(*)` })
      .from(clientTransactions)
      .where(
        and(
          eq(clientTransactions.type, 'payment'),
          isNull(clientTransactions.accountId),
          isNull(clientTransactions.voidedAt),
          sql`${clientTransactions.txDate} >= ${`${month}-01`}`,
        ),
      ),
    // Mirrors generateRecurring's own idempotence check: a template counts
    // as due only while no live expense sits on its (category, date,
    // employee) slot for the current month.
    db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM recurring_expenses r
      WHERE r.active = true
        AND NOT EXISTS (
          SELECT 1 FROM expenses e
          WHERE e.category_id = r.category_id
            AND e.expense_date = (${month} || '-' || lpad(r.day_of_month::text, 2, '0'))::date
            AND e.voided_at IS NULL
            AND ((r.employee_id IS NULL AND e.employee_id IS NULL) OR e.employee_id = r.employee_id)
        )
    `),
    costMissingBatches(3),
  ]);
  return {
    snapshot,
    unassignedPayments: Number(unassigned[0]?.n ?? 0),
    recurringDue: Number(recurring[0]?.n ?? 0),
    costMissing: costMissing.length,
  };
}

export interface VedFlowCounts {
  /** Open hisoblash requests sitting on THIS person — the round-28 clock. */
  calcOpen: number;
  /** …of which already past their deadline. */
  calcLate: number;
  /** Departed export paperwork not yet sent to the agent. */
  docsPending: number;
  /** Goods lines on OPEN deals with no TNVED code — the classification queue. */
  tnvedMissing: number;
}

export async function vedFlowCounts(actorId: string): Promise<VedFlowCounts> {
  const now = new Date();
  const [calcRows, docs, tnved] = await Promise.all([
    db
      .select({ dueAt: calcRequests.dueAt })
      .from(calcRequests)
      .where(and(eq(calcRequests.assigneeId, actorId), isNull(calcRequests.completedAt))),
    // A truck that left without its papers reaching the agent is the thing
    // this person gets phoned about; unloaded means customs is behind it.
    db
      .select({ n: sql<number>`count(*)` })
      .from(batches)
      .where(and(inArray(batches.status, ['in_transit', 'arrived']), isNull(batches.sentToAgentAt))),
    db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
      FROM deal_lines dl
      JOIN deals d ON d.id = dl.deal_id
      JOIN deal_stages s ON s.id = d.stage_id
      WHERE s.kind = 'open' AND (dl.tnved_code IS NULL OR btrim(dl.tnved_code) = '')
    `),
  ]);
  return {
    calcOpen: calcRows.length,
    calcLate: calcRows.filter((row) => row.dueAt < now).length,
    docsPending: Number(docs[0]?.n ?? 0),
    tnvedMissing: Number(tnved[0]?.n ?? 0),
  };
}

export type HomeFlow =
  | { kind: 'warehouse'; hrefs: string[]; counts: WarehouseFlowCounts }
  | { kind: 'logist'; hrefs: string[]; counts: LogistFlowCounts }
  | { kind: 'sales'; hrefs: string[]; counts: SalesFlowCounts }
  | { kind: 'ved'; hrefs: string[]; counts: VedFlowCounts }
  | { kind: 'accountant'; hrefs: string[]; counts: MoneyFlowCounts };

/**
 * Which home this person wakes up to. First match wins, narrowest job first;
 * `hrefs` are the screens the flow already draws, so the tile grid below
 * must not repeat them. super_admin/admin deliberately match nothing — the
 * owner keeps the tile overview.
 */
export async function buildHomeFlow(
  actor: ScopedActor & { id: string; roles: string[] },
  today: string,
): Promise<HomeFlow | null> {
  if (actor.warehouseScoped) {
    return {
      kind: 'warehouse',
      hrefs: ['/receive', '/arrivals', '/batches', '/issue'],
      counts: await warehouseFlowCounts(actor, today),
    };
  }
  if (actor.roles.includes('logist')) {
    return {
      kind: 'logist',
      hrefs: ['/plans', '/batches', '/arrivals'],
      counts: await logistFlowCounts(actor, today),
    };
  }
  if (actor.roles.includes('sales_manager')) {
    return {
      kind: 'sales',
      hrefs: ['/crm/today', '/crm', '/suhbatlar', '/my-clients', '/bitimlar'],
      counts: await salesFlowCounts(actor.id, today),
    };
  }
  // Round 30 — the last working role without a workflow home. After sales:
  // a person wearing both hats lives the funnel's day; the calc queue still
  // reaches them through /bugun.
  if (actor.roles.includes('ved_manager')) {
    return {
      kind: 'ved',
      hrefs: ['/bugun', '/batches', '/bitimlar'],
      counts: await vedFlowCounts(actor.id),
    };
  }
  if (actor.roles.includes('accountant')) {
    return {
      kind: 'accountant',
      hrefs: ['/accounting', '/finance'],
      counts: await moneyFlowCounts(today),
    };
  }
  return null;
}
