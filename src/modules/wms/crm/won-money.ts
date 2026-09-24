import { sql, type SQL } from 'drizzle-orm';
import { dealStages, deals, leadStages, leads } from '../../platform/db/schema';

/**
 * Won money, in DOLLARS — one home for the sums every CRM report prints
 * (audit 2026-09-24, A19 and A21; #513).
 *
 * A lead and a deal can each be quoted in USD, UZS or CNY — both forms offer
 * all three and both services accept them — and every «won $» figure summed
 * `quoted_amount` with no currency clause, so a job quoted at 45,000,000 so'm
 * (≈ $3,600) was printed as $45,000,000, on the same admin card as the
 * open-deals sum that has filtered USD since round 107 (`openDealsSummary`).
 * A non-dollar win is COUNTED beside the sum instead, so the screen can say
 * «+N boshqa valyutada» rather than lie by omission.
 *
 * A deal's figure is NET of its recorded damage discount: the card prints the
 * agreed price minus the discount, and a report summing the gross overstated
 * every discounted job by exactly that amount (A21).
 */
/**
 * A lead's currency column carries no CHECK (0062 added it bare) and a quote
 * with no currency is round 71's «a lead is quoted in dollars» — so NULL reads
 * as USD here, and nothing that summed as dollars yesterday stops counting.
 */
export function leadCurrencySql(): SQL<string> {
  return sql<string>`coalesce(${leads.quotedCurrency}, 'USD')`;
}

export function leadWonUsdSql(): SQL<string> {
  return sql<string>`coalesce(sum(${leads.quotedAmount}) FILTER (WHERE ${leadStages.kind} = 'won' AND ${leadCurrencySql()} = 'USD'), 0)`;
}

export function leadWonOtherCurrencySql(): SQL<number> {
  return sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'won' AND ${leads.quotedAmount} IS NOT NULL AND ${leadCurrencySql()} <> 'USD')`;
}

export function dealWonUsdSql(): SQL<string> {
  return sql<string>`coalesce(sum(${deals.quotedAmount} - ${deals.discountAmount}) FILTER (WHERE ${dealStages.kind} = 'won' AND ${deals.quotedCurrency} = 'USD'), 0)`;
}

export function dealWonOtherCurrencySql(): SQL<number> {
  return sql<number>`count(*) FILTER (WHERE ${dealStages.kind} = 'won' AND ${deals.quotedAmount} IS NOT NULL AND ${deals.quotedCurrency} <> 'USD')`;
}
