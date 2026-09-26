-- A counterparty's payment terms (the owner, 2026-09-26, his 8a: «kontragentlar
-- bilan oldi berdini deadline tuzilishi kerak summa boyicha yokida date
-- boyicha»). Two answers a person types on the card, both optional:
--   pay_within_days — every debt is due N days after it was written, paid
--                     oldest first;
--   debt_limit_usd  — what we let ourselves owe this firm.
-- And the two stamps that make each reminder fire ONCE: the due date the
-- «N kun qoldi» / «muddati o'tdi» messages were sent for, and when the «80 %
-- of the limit» one went (cleared when the debt falls back below it).
ALTER TABLE "partners"
  ADD COLUMN "pay_within_days" integer,
  ADD COLUMN "debt_limit_usd" numeric(14, 2),
  ADD COLUMN "due_soon_alerted_for" date,
  ADD COLUMN "overdue_alerted_for" date,
  ADD COLUMN "limit_alerted_at" timestamp with time zone;
ALTER TABLE "partners" ADD CONSTRAINT "partners_pay_within_days_check"
  CHECK ("pay_within_days" IS NULL OR ("pay_within_days" > 0 AND "pay_within_days" <= 3650));
-- `<> 'NaN'` is the only comparison postgres has that excludes NaN (#777).
ALTER TABLE "partners" ADD CONSTRAINT "partners_debt_limit_check"
  CHECK ("debt_limit_usd" IS NULL OR ("debt_limit_usd" > 0 AND "debt_limit_usd" <> 'NaN'::numeric));
