import { sql } from 'drizzle-orm';
import { occurrencesSql, paidSql, skippedSql } from '../accounting/recurring-sql';
import type { Exec } from './cargo';

/**
 * A person's SALARY is not a new table (0117, his 8a): it is the recurring
 * template he already keeps for rent and salaries (0099 / 0106 — «To'landi»
 * when the kassa holder actually pays) that names the person, in the salary
 * category (`salary_expense_category_id`). Any other template naming them —
 * a phone, a flat — is «Boshqa doimiy to'lovlar» and never added to the
 * oylik. With the category unset every person-template reads as salary, and
 * /hodimlar asks for the category in words.
 *
 * The state is THIS Tashkent month's — never a month a page is viewing for
 * something else (/hodimlar's `?oy` is the KPI's closed month, and a chip
 * beside the salary reading July's «to'langan» in September is a false
 * sentence). It is the due list's own predicates (`paidSql`, `skippedSql`,
 * `occurrencesSql` — accounting/recurring-sql.ts), never a restatement: a
 * salary shown «to'langan» here and «qarz» on /accounting/expenses would be
 * one question with two answers (#513). A month the template does not owe —
 * before its `due_from`, created today to start next month — is no
 * occurrence there and «not due» here, never «kutilmoqda».
 */

export type SalaryState = 'paid' | 'skipped' | 'waiting' | 'not_due';

export interface StaffTemplate {
  id: string;
  employeeId: string;
  categoryId: string;
  categoryName: string;
  categoryCash: boolean;
  amount: string;
  currency: string;
  dayOfMonth: number;
  active: boolean;
  accountId: string | null;
  partnerId: string | null;
  /** The template's own kassa / firm, open or closed — what the row edit re-posts. */
  accountName: string | null;
  accountCurrency: string | null;
  accountActive: boolean | null;
  partnerName: string | null;
  partnerActive: boolean | null;
  /** In the salary category (or the category is unset). */
  salary: boolean;
  /** `month`'s occurrence. */
  state: SalaryState;
  /** `YYYY-MM` the state is about — today's Tashkent month, named on the chip. */
  month: string;
}

/**
 * Every ACTIVE template naming a person — or those of one person — with the
 * state of `today`'s month (`today` is a Tashkent `YYYY-MM-DD`).
 */
export async function staffTemplates(
  exec: Exec,
  q: { today: string; salaryCategoryId: string; userId?: string },
): Promise<StaffTemplate[]> {
  const thisMonth = q.today.slice(0, 7);
  const month = sql`${`${thisMonth}-01`}::date`;
  const rows = (await exec.execute(sql`
    SELECT r.id, r.employee_id, r.category_id, ec.name AS category_name, ec.cash AS category_cash,
           r.amount::text AS amount, r.currency, r.day_of_month, r.active, r.account_id, r.partner_id,
           ma.name AS account_name, ma.currency AS account_currency, ma.active AS account_active,
           p.name AS partner_name, p.active AS partner_active,
           ${paidSql(sql`r.id`, month)} AS paid,
           ${skippedSql(sql`r.id`, month)} AS skipped,
           (o.recurring_id IS NOT NULL) AS owed
      FROM recurring_expenses r
      LEFT JOIN (${occurrencesSql(q.today)}) o ON o.recurring_id = r.id AND o.month = ${month}
      JOIN expense_categories ec ON ec.id = r.category_id
      LEFT JOIN money_accounts ma ON ma.id = r.account_id
      LEFT JOIN partners p ON p.id = r.partner_id
     WHERE r.employee_id IS NOT NULL AND r.active
       ${q.userId ? sql`AND r.employee_id = ${q.userId}::uuid` : sql``}
     ORDER BY r.employee_id, r.created_at`)) as unknown as {
    id: string;
    employee_id: string;
    category_id: string;
    category_name: string;
    category_cash: boolean;
    amount: string;
    currency: string;
    day_of_month: number;
    active: boolean;
    account_id: string | null;
    partner_id: string | null;
    account_name: string | null;
    account_currency: string | null;
    account_active: boolean | null;
    partner_name: string | null;
    partner_active: boolean | null;
    paid: boolean;
    skipped: boolean;
    owed: boolean;
  }[];
  return [...rows].map((row) => ({
    id: row.id,
    employeeId: row.employee_id,
    categoryId: row.category_id,
    categoryName: row.category_name,
    categoryCash: row.category_cash,
    amount: row.amount,
    currency: row.currency,
    dayOfMonth: Number(row.day_of_month),
    active: row.active,
    accountId: row.account_id,
    partnerId: row.partner_id,
    accountName: row.account_name,
    accountCurrency: row.account_currency,
    accountActive: row.account_active,
    partnerName: row.partner_name,
    partnerActive: row.partner_active,
    salary: !q.salaryCategoryId || row.category_id === q.salaryCategoryId,
    state: row.paid ? 'paid' : row.skipped ? 'skipped' : row.owed ? 'waiting' : 'not_due',
    month: thisMonth,
  }));
}
