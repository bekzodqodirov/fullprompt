import { sql } from 'drizzle-orm';
import { paidSql, skippedSql } from '../accounting/recurring-sql';
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
 * This month's state is the due list's own predicates (`paidSql`,
 * `skippedSql` — accounting/recurring-sql.ts), never a restatement: a salary
 * shown «to'langan» here and «qarz» on /accounting/expenses would be one
 * question with two answers (#513).
 */

export type SalaryState = 'paid' | 'skipped' | 'waiting';

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
  /** In the salary category (or the category is unset). */
  salary: boolean;
  /** This month's occurrence. */
  state: SalaryState;
}

/**
 * Every ACTIVE template naming a person — or those of one person — with
 * this month's state. `month` is `YYYY-MM`.
 */
export async function staffTemplates(
  exec: Exec,
  q: { month: string; salaryCategoryId: string; userId?: string },
): Promise<StaffTemplate[]> {
  const month = sql`${`${q.month}-01`}::date`;
  const rows = (await exec.execute(sql`
    SELECT r.id, r.employee_id, r.category_id, ec.name AS category_name, ec.cash AS category_cash,
           r.amount::text AS amount, r.currency, r.day_of_month, r.active, r.account_id, r.partner_id,
           ${paidSql(sql`r.id`, month)} AS paid,
           ${skippedSql(sql`r.id`, month)} AS skipped
      FROM recurring_expenses r
      JOIN expense_categories ec ON ec.id = r.category_id
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
    paid: boolean;
    skipped: boolean;
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
    salary: !q.salaryCategoryId || row.category_id === q.salaryCategoryId,
    state: row.paid ? 'paid' : row.skipped ? 'skipped' : 'waiting',
  }));
}
