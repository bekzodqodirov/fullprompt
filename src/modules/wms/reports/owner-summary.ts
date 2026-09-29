import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { costEntries, partners } from '../../platform/db/schema';
import { isAnalyst } from '../../platform/ai/tools';
import { addDays, tashkentMinute } from '../../platform/time/tashkent';
import { cashFlow, companyBalanceParts, profitAndLoss } from '../accounting/reports';
import { recurringDue } from '../accounting/recurring';
import { openExpenseRequestTotals } from '../accounting/expense-requests';
import { clientMoneyInPeriod } from '../finance/service';
import type { CompanyMoneySight } from '../finance/scope';
import { termStates } from '../partners/terms-service';
import { trucksOnRoad } from '../tracking/on-road';
import { attentionFacts, attentionGates } from './attention';
import { readAttentionSources } from './attention-sources';
import { intakeByDay } from './business';
import { loadLeadFlow, scopeKeyOf, unkey } from './dashboard';
import { attentionLive, dashboardWindows, pnlParts, rankAttention } from './dashboard-math';
import { truckMoves } from './overview';
import { ownerSummarySight, type OwnerSummaryActor } from './owner-summary-door';
import {
  ownerSummaryText,
  paymentsDue,
  PAYMENTS_DAYS,
  summaryQuiet,
  summaryWindow,
  type DuePartner,
  type DueUnratedCost,
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
 * The dated firms' debts that have no dollars yet — `partnersDue`'s other
 * half. A cost that names a firm as its payer posts the firm's charge only
 * once its currency has a rate (`chargeForCost`: a charge is frozen in
 * dollars, R1), so until the rate arrives the debt is on NO partner ledger
 * and `termStates` cannot see it. Read from the cost itself, in its own
 * money, per cost row: the grouping is the pure file's (overdue and coming
 * apart, per firm and currency), and only the window's bound is asked here.
 * Dated firms only — a firm with no `pay_within_days` owes no dated money,
 * converted or not.
 */
async function partnersUnrated(today: string): Promise<DueUnratedCost[]> {
  const dueDay = sql`(${costEntries.costDate} + ${partners.payWithinDays})`;
  const rows = await db
    .select({
      name: partners.name,
      active: partners.active,
      currency: costEntries.currency,
      amount: costEntries.amount,
      dueDate: sql<string>`${dueDay}::text`,
    })
    .from(costEntries)
    .innerJoin(partners, eq(partners.id, costEntries.partnerId))
    .where(
      and(
        isNull(costEntries.amountUsd),
        isNull(costEntries.voidedAt),
        isNotNull(partners.payWithinDays),
        sql`${dueDay} <= ${addDays(today, PAYMENTS_DAYS)}::date`,
      ),
    );
  return rows.map((row) => ({ ...row, amount: Number(row.amount) }));
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
  const seesOutcome = isAnalyst(actor) && actor.permissions.has('crm.manage');

  // Read ONCE and handed to the attention list too (judge 7): outside a
  // render the loaders' `cache()` is a plain call-through, so asking twice
  // would pay twice. Both are awaited inside the ONE Promise.all below.
  // The sellers' commissions are a company-wide walk (his 3a) that left the
  // parts: read below, on Mondays only and through the Balans's minute-long
  // memo — the daily message never prints them and must not pay for the
  // walk. Imported where asked, like reports.ts, and
  // BEFORE the two promises start (one awaited later while another await is
  // pending is an unhandled rejection).
  const { upsaleLiabilityForNet } = await import('../calc/upsale-service');
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
    readAttentionSources(gates, scopeKey, now, actor, { balance: balanceP, trucks: trucksP }),
    weekly
      ? Promise.all([
          recurringDue(today),
          partnersDue(today),
          partnersUnrated(today),
          openExpenseRequestTotals(),
          upsaleLiabilityForNet(),
        ])
      : null,
  ]);

  const facts = attentionFacts(gates, sources, dashboardWindows(today));
  // On a Monday the rent-and-salary row moves INTO the payments block, in the
  // block's own words and numbers (judge 5): one message must not count one
  // overdue month twice by two rules. The row's own gate and liveness decide
  // whether there is anything to move (`attentionLive`, the list's test).
  const arrearsFact = weekly ? (facts.find((fact) => fact.kind === 'recurringDue' && attentionLive(fact)) ?? null) : null;
  const ranked = rankAttention(
    weekly ? facts.filter((fact) => fact.kind !== 'recurringDue') : facts,
    ATTENTION_TOP,
  );

  let weeklyBlock: SummaryFacts['weeklyBlock'] = null;
  if (weeklyReads) {
    const [recurring, duePartners, unratedPartners, pending, commissions] = weeklyReads;
    // The Balans's arrears, split the way a payments heading must say them:
    // the cash months (the Balans's count and dollars), the cash months with
    // no rate (their own money), and the book entries the attention row's
    // total also counts — which move no kassa and are named, never paid.
    const unratedMonths = balance.recurringArrearsUnrated.reduce((n, row) => n + row.count, 0);
    const arrears = arrearsFact
      ? {
          cashCount: balance.recurringArrearsCount,
          usd: balance.recurringArrearsUsd,
          unrated: balance.recurringArrearsUnrated,
          bookCount: Math.max(0, balance.recurringArrearsTotal - balance.recurringArrearsCount - unratedMonths),
        }
      : null;
    weeklyBlock = {
      payments: paymentsDue({
        today,
        recurring,
        partners: duePartners,
        partnersUnrated: unratedPartners,
        upsale: {
          usd: commissions.payableUsd,
          count: commissions.payableCount,
          unknownCount: commissions.unknownCount,
          unknownUsd: commissions.unknownUsd,
        },
        arrears: arrears ? { usd: arrears.usd, unrated: arrears.unrated } : null,
      }),
      arrears,
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
