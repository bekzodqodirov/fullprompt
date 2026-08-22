import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { calcQueueCounts } from '../calc/service';
import {
  batches,
  clientTransactions,
  dealStages,
  deals,
  loadPlans,
} from '../../platform/db/schema';
import type { ScopedActor } from '../../platform/rbac/scope';
import { chatBadges } from '../crm/conversations';
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
  /** Conversations that still need an answer — `new`, never merely unread. */
  waitingChats: number;
  /** Own clients currently owing money. */
  debtors: number;
  openDeals: number;
}

export async function salesFlowCounts(actorId: string, today: string): Promise<SalesFlowCounts> {
  const [calls, openLeads, waiting, book, openDealRows] = await Promise.all([
    followUps(today, actorId),
    openLeadCount(actorId),
    /**
     * How many of THIS manager's own threads still need an answer — the same
     * rows their /suhbatlar screen shows, and no one else's (a colleague's
     * personal Telegram is not this person's morning list).
     *
     * Through `chatBadges`, deliberately, rather than the hand-written
     * DISTINCT ON that used to live here: this was the FOURTH restatement of
     * «is this waiting», and it disagreed with the other three the day round
     * 88 gave the answer three values. It also carried a defect of its own —
     * no `client_id IS NOT NULL`, and postgres groups all NULLs together, so
     * every lead-owned chat in the company collapsed into one phantom
     * «waiting» on this screen, openable nowhere and clearable by nothing.
     */
    chatBadges({ id: actorId }),
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
    waitingChats: [...waiting.values()].filter((mark) => mark === 'waiting').length,
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
  /** THIS month's payments with no cash box AND no counterparty behind them —
   *  bounded so the years of pre-accounts history don't drown the actionable
   *  few, and partner-settled so the queue only holds work somebody can do. */
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
          // A three-cornered settlement's client half has no cash box BY
          // CONSTRUCTION — the money went into the supplier's account, not a
          // till of ours (#415) — and no screen can ever name one for it. It
          // was posting a chore the accountant could not finish, one per
          // settlement, until the month rolled over. Same clause, same
          // reason as `cashFlow`.
          isNull(clientTransactions.partnerId),
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
            AND ((r.warehouse_id IS NULL AND e.warehouse_id IS NULL) OR e.warehouse_id = r.warehouse_id)
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
  /** Calculations waiting in the queue — the VED module's own day (phase A). */
  calcOpen: number;
  /** …of which already past their deadline. */
  calcLate: number;
  /** Departed export paperwork not yet sent to the agent. */
  docsPending: number;
  /** Goods lines on OPEN deals with no TNVED code — the classification queue. */
  tnvedMissing: number;
}

export async function vedFlowCounts(): Promise<VedFlowCounts> {
  const [calc, docs, tnved] = await Promise.all([
    // The same fragment the queue screen filters by, so the number here and
    // the rows there cannot disagree (#513).
    calcQueueCounts(),
    // A truck that left without its papers reaching the agent is the thing
    // this person gets phoned about; unloaded means customs is behind it.
    db
      .select({ n: sql<number>`count(*)` })
      .from(batches)
      .where(
        and(inArray(batches.status, ['in_transit', 'arrived']), isNull(batches.sentToAgentAt)),
      ),
    db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
      FROM deal_lines dl
      JOIN deals d ON d.id = dl.deal_id
      JOIN deal_stages s ON s.id = d.stage_id
      WHERE s.kind = 'open' AND (dl.tnved_code IS NULL OR btrim(dl.tnved_code) = '')
    `),
  ]);
  return {
    calcOpen: calc.open,
    calcLate: calc.late,
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
      hrefs: ['/receive', '/batches', '/issue'],
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
      // In the order the rows are drawn. Matched against `item.href`, so a
      // row whose link carries a query string (`/my-clients?filter=debt`)
      // is still named here by its bare NAV href.
      hrefs: ['/crm/today', '/bitimlar', '/crm', '/suhbatlar', '/my-clients'],
      counts: await salesFlowCounts(actor.id, today),
    };
  }
  // Round 30 — the last working role without a workflow home. After sales:
  // a person wearing both hats lives the funnel's day; the calc queue still
  // reaches them through /bugun.
  if (actor.roles.includes('ved_manager')) {
    return {
      kind: 'ved',
      // `/bugun` is deliberately NOT here: an href named in this list is a
      // tile SUPPRESSED below, and the flow draws no row for the day screen —
      // naming it would hide it entirely (round 83's trap). `/hisoblash` is
      // named because the flow's first row IS the queue, and that row is
      // drawn even when the count is zero, or a quiet morning would leave
      // this person with no door to it at all.
      hrefs: ['/hisoblash', '/batches', '/bitimlar'],
      counts: await vedFlowCounts(),
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
