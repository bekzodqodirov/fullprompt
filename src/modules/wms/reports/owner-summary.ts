import { inArray } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { partners } from '../../platform/db/schema';
import { tashkentMinute } from '../../platform/time/tashkent';
import { cashFlow, companyBalanceParts, profitAndLoss } from '../accounting/reports';
import { recurringDue } from '../accounting/recurring';
import { openExpenseRequestTotals } from '../accounting/expense-requests';
import { clientMoneyInPeriod } from '../finance/service';
import type { CompanyMoneySight } from '../finance/scope';
import { termStates } from '../partners/terms-service';
import { trucksOnRoad } from '../tracking/on-road';
import { attentionFacts, attentionGates, type AttentionFact } from './attention';
import { readAttentionSources } from './attention-sources';
import { intakeByDay } from './business';
import { loadLeadFlow, scopeKeyOf, unkey } from './dashboard';
import { dashboardWindows, pnlParts, rankAttention } from './dashboard-math';
import { truckMoves } from './overview';
import { ownerSummarySight, type OwnerSummaryActor } from './owner-summary-door';
import {
  ownerSummaryText,
  paymentsDue,
  summaryQuiet,
  summaryWindow,
  type DuePartner,
  type SummaryFacts,
  type SummaryWindowKey,
} from './owner-summary-text';
import { reportBaseIds, type ScopeActor } from './report-scope';

/**
 * The owner's evening Telegram (answer 7a, 2026-09-28): «har kuni 20:00 faqat
 * sizga + dushanba haftalik (kelgusi to'lovlar bilan)».
 *
 * Every figure here is the EXPORTED function of the report the dashboard
 * prints it from, over the same window (#513) — this file only reads them
 * side by side and hands them to the words (owner-summary-text.ts). The link
 * at the foot opens the dashboard over exactly that window, so a figure in
 * the message can be found again one tap away.
 *
 * The same text answers the push (the job, owner-summary-jobs.ts) and the pull
 * («📊 Holat» / /holat in the staff bot), so the owner never reads two
 * versions of one evening.
 */

/** How many attention rows the message names; the rest are counted. */
export const ATTENTION_TOP = 3;

export interface OwnerSummary {
  text: string;
  quiet: boolean;
  day: string;
  window: SummaryWindowKey;
  facts: SummaryFacts;
}

type SummaryActor = OwnerSummaryActor & ScopeActor;

/** The counterparties with dated debts, named — `termStates` carries no names. */
async function partnersDue(today: string): Promise<DuePartner[]> {
  const states = await termStates(undefined, today);
  const ids = [...states.entries()].filter(([, state]) => state.open.length > 0).map(([id]) => id);
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: partners.id, name: partners.name, active: partners.active })
    .from(partners)
    .where(inArray(partners.id, ids));
  return rows.map((row) => ({ name: row.name, active: row.active, open: states.get(row.id)!.open }));
}

/**
 * Everything the message says, read ONCE. The `sight` is REQUIRED and can only
 * come from `companyMoneySight` / `ownerSummarySight` — a caller cannot reach
 * the company's money here without having asked the door (round B, O6).
 *
 * Cargo is the actor's own base scope (`reportBaseIds`, through the loaders'
 * key so a scoped actor with no warehouse reads NOTHING, judge 9); money has
 * no per-warehouse figure and is the company's, as on the dashboard.
 */
export async function composeOwnerSummary(
  actor: SummaryActor,
  sight: CompanyMoneySight,
  now: Date = new Date(),
  opts: { pull?: boolean } = {},
): Promise<OwnerSummary> {
  const { today, weekly, key, period } = summaryWindow(now);
  const baseIds = reportBaseIds(actor);
  const scopeKey = scopeKeyOf(baseIds);
  const ids = unkey(scopeKey);
  const gates = attentionGates(actor.permissions, { sight, scoped: baseIds !== undefined, company: false });
  // The funnel card's own outcome gate (analyst + crm.manage): the won
  // dollars are the sales outcome, not the company's cash.
  const analyst = actor.roles.includes('super_admin') || actor.roles.includes('admin');
  const seesOutcome = analyst && actor.permissions.has('crm.manage');

  // Read ONCE and handed to the attention list too (judge 7): outside a
  // render the loaders' `cache()` is a plain call-through, so asking twice
  // would pay twice. Both are awaited inside the ONE Promise.all below.
  const balanceP = companyBalanceParts();
  const trucksP = trucksOnRoad(ids, { limit: 0, now });
  const [pnl, flow, collected, intake, moves, trucks, balance, leads, sources, weeklyReads] = await Promise.all([
    profitAndLoss(period.from, period.to),
    cashFlow(period.from, period.to),
    clientMoneyInPeriod(period.from, period.to),
    intakeByDay(period.from, period.to, ids),
    truckMoves(period.from, period.to, ids),
    trucksP,
    balanceP,
    seesOutcome ? loadLeadFlow(period.from, period.to) : null,
    readAttentionSources(gates, scopeKey, now, { balance: balanceP, trucks: trucksP }),
    weekly ? Promise.all([recurringDue(today), partnersDue(today), openExpenseRequestTotals()]) : null,
  ]);

  const facts = attentionFacts(gates, sources, dashboardWindows(today));
  const live = (fact: AttentionFact) => fact.count > 0 || (fact.usd ?? 0) > 0.009;
  // On a Monday the rent-and-salary row moves INTO the payments block, in its
  // own words and numbers (judge 5): one message must not count one overdue
  // month twice by two rules.
  const arrearsFact = weekly ? (facts.find((fact) => fact.kind === 'recurringDue' && live(fact)) ?? null) : null;
  const ranked = rankAttention(
    weekly ? facts.filter((fact) => fact.kind !== 'recurringDue') : facts,
    ATTENTION_TOP,
  );

  let weeklyBlock: SummaryFacts['weeklyBlock'] = null;
  if (weeklyReads) {
    const [recurring, duePartners, pending] = weeklyReads;
    weeklyBlock = {
      payments: paymentsDue({
        today,
        recurring,
        partners: duePartners,
        upsale: { usd: balance.sellerCommissionsUsd, count: balance.sellerCommissionsCount },
        arrears: arrearsFact
          ? { usd: balance.recurringArrearsUsd, unrated: balance.recurringArrearsUnrated }
          : null,
      }),
      arrears: arrearsFact,
      arrearsUnrated: arrearsFact ? balance.recurringArrearsUnrated : [],
      pendingSpend: pending,
      receivableUsd: balance.receivableUsd,
    };
  }

  const summary: SummaryFacts = {
    day: today,
    weekly,
    from: period.from,
    to: period.to,
    asOf: tashkentMinute(now).slice(11, 16),
    revenueUsd: pnlParts(pnl, 'total').revenue,
    collectedUsd: collected.netCollected,
    cash: {
      inUsd: flow.inflow,
      outUsd: flow.outflow,
      unconverted: {
        count: flow.unconverted.count,
        byCurrency: flow.unconverted.byCurrency.map((row) => ({ currency: row.currency, amount: row.amount })),
      },
    },
    tills: { usd: balance.cashUsd, count: balance.cashRows.length, unrated: balance.unratedTills },
    intake: intake.total,
    trucks: { departed: moves.departed, arrived: moves.arrived, onRoad: trucks.total },
    leads: leads
      ? { fresh: leads.fresh, won: leads.won, wonUsd: leads.wonUsd, wonOther: leads.wonOther }
      : null,
    attention: { total: ranked.visibleCount, top: ranked.visible },
    weeklyBlock,
    link: `${process.env.APP_URL ?? ''}/dashboard?davr=${key}`,
  };
  const quiet = summaryQuiet(summary);
  return {
    text: ownerSummaryText(summary, { quietLine: opts.pull === true && quiet }),
    quiet,
    day: today,
    window: key,
    facts: summary,
  };
}

/**
 * The pull («📊 Holat», /holat): the door and the compose in one, for a caller
 * that holds an actor but no token — the staff bot. Null when the door says
 * no; the bot answers that in words and never falls through to the model.
 */
export async function ownerSummaryForActor(actor: SummaryActor, now: Date = new Date()): Promise<OwnerSummary | null> {
  const sight = ownerSummarySight(actor);
  if (!sight) return null;
  return composeOwnerSummary(actor, sight, now, { pull: true });
}
