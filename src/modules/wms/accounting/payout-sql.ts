import { sql, type SQL } from 'drizzle-orm';

/**
 * «This expense is a COMMISSION paid to a seller» — the upsale's share
 * (`calc_offers.payout_expense_id`, 0088) or the KPI's (`kpi_payouts`, 0117) —
 * said ONCE (#513). Two readers must not mistake one for anything else:
 *
 *  - «To'landi» / «Bog'lash» (`candidatesSql`, accounting/recurring-sql.ts):
 *    a commission paid to Dilnoza in October must never be offered as
 *    Dilnoza's October SALARY — the template's slot is (category, person,
 *    month) and a KPI payout in a mis-picked category would close her month;
 *  - the cost merge (accounting/cost-merge.ts): a payout is money handed to a
 *    person, never «the same money typed twice» as a truck's cost.
 *
 * It used to be the upsale's literal alone, written out in both places; the
 * KPI payout would have slipped past both. `tests/unit/commission-payout-fence
 * .test.ts` refuses the pattern anywhere else.
 */
export function commissionPayoutSql(expenseId: SQL): SQL {
  return sql`(EXISTS (SELECT 1 FROM calc_offers co WHERE co.payout_expense_id = ${expenseId})
          OR EXISTS (SELECT 1 FROM kpi_payouts kp WHERE kp.expense_id = ${expenseId}))`;
}
