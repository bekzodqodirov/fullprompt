-- Audit 2026-09-24 (A32, A33, A36): a monthly fixed cost knows which
-- template posted it, and a template can name who pays it.
--
-- A32/A33: `generateRecurring` decided «already posted» by a SLOT — any live
-- expense on (category, date, employee, warehouse) — so a one-off bonus or a
-- repair typed on payday counted as that month's salary or rent and the real
-- one never posted; and voiding a wrong posting re-armed its template, so the
-- next press posted the same wrong amount again. The posting now carries its
-- template, and «posted this month» is «a row of THIS template on that date,
-- voided or not» — voiding means «not this month», never «post it again».
--
-- A36: rent and Chinese salaries are paid through the transport company
-- (round 39); a template dropped the payer, so every posting was an
-- own-paid expense and no debt to the firm was raised.
--
-- Additive and nullable. The backfill links the postings the old slot rule
-- would have recognised, and only those carrying the template's own amount
-- and currency — so this month's already-posted rent is not posted twice on
-- the first press after the deploy, and a one-off with a different amount is
-- left alone. A plain index, not a unique one: history may hold a double
-- posting from before the fix, and a unique index would refuse the deploy.

ALTER TABLE expenses ADD COLUMN recurring_id uuid REFERENCES recurring_expenses(id);
CREATE INDEX expenses_recurring_idx ON expenses (recurring_id, expense_date) WHERE recurring_id IS NOT NULL;

ALTER TABLE recurring_expenses ADD COLUMN partner_id uuid REFERENCES partners(id);

UPDATE expenses e
   SET recurring_id = r.id
  FROM recurring_expenses r
 WHERE e.recurring_id IS NULL
   AND e.category_id = r.category_id
   AND e.employee_id IS NOT DISTINCT FROM r.employee_id
   AND e.warehouse_id IS NOT DISTINCT FROM r.warehouse_id
   AND extract(day FROM e.expense_date)::int = r.day_of_month
   AND e.amount = r.amount
   AND e.currency = r.currency;
