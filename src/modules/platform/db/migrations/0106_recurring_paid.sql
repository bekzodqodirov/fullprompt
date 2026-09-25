-- Owner's Q6 (2026-09-25): «fakticheskiy ayrilsin … kassaga mas'ul odam
-- kassadan to'lasin, o'zidan o'zi yechib olinmasin». A recurring expense is
-- written only by a person — «To'landi» on the day the money left, or
-- «Bog'lash» onto a payment already typed — so a posting's DATE is the
-- payment day and can no longer say which month it answers. That is a second
-- fact and gets its own column. «Not this month» gets its own record instead
-- of borrowing a voided posting (0099, #999): a voided payment now means
-- «that payment was a mistake», which must put the item back on the list.
--
-- Additive. The month is backfilled from the posting's own date (under 0099
-- every posting was dated month-dayOfMonth, so that IS its month). No unique
-- index on (template, month): history may hold a double posting (#999's
-- reason), and a unique index would refuse the whole multi-migration deploy.
-- The template's row lock in every writer is the fence.

ALTER TABLE expenses
  ADD COLUMN recurring_month date,
  ADD COLUMN recurring_partial boolean NOT NULL DEFAULT false;

UPDATE expenses
   SET recurring_month = date_trunc('month', expense_date)::date
 WHERE recurring_id IS NOT NULL;

-- One-directional on purpose. A month needs a template; a template does not
-- need a month at the SQL level, because accounting.integration.test.ts
-- replays 0099's own backfill (UPDATE … SET recurring_id) inside a
-- rolled-back transaction, and the OLD app keeps serving while this runs.
-- Every reader takes the month as coalesce(recurring_month, month of
-- expense_date) — this backfill's own rule — so a row with no month still
-- answers its date's month instead of vanishing (`postingMonth`).
-- extract(day …) and not date_trunc: immutable, no session time zone.
ALTER TABLE expenses ADD CONSTRAINT expenses_recurring_month_check CHECK (
  (recurring_month IS NULL OR recurring_id IS NOT NULL)
  AND (recurring_month IS NULL OR extract(day FROM recurring_month) = 1)
  AND (NOT recurring_partial OR recurring_id IS NOT NULL)
);

DROP INDEX expenses_recurring_idx;
CREATE INDEX expenses_recurring_month_idx
  ON expenses (recurring_id, recurring_month) WHERE recurring_id IS NOT NULL;

-- The first month a template can be due. New rows: Tashkent's today (the
-- column default, so a direct insert in a test or a script behaves); the
-- create form may set the first of NEXT month instead. Existing rows: the
-- first of the deploy month — every older month is outside the window, as
-- `cost_kassa_since` put older costs outside the kassa queue (#1018). Older
-- months that carry a posting stay reachable through the posting union
-- (accounting/recurring.ts), which is how a later void of one re-lists it.
ALTER TABLE recurring_expenses
  ADD COLUMN due_from date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Tashkent')::date);
UPDATE recurring_expenses
   SET due_from = date_trunc('month', now() AT TIME ZONE 'Asia/Tashkent')::date;

-- «Bu oy yo'q»: a month closed with no money, in words. Not granted to
-- gsr_ai_reader — 0080's allowlist denies a table no migration names.
CREATE TABLE recurring_skips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recurring_id uuid NOT NULL REFERENCES recurring_expenses(id),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX recurring_skips_live_idx
  ON recurring_skips (recurring_id, month) WHERE voided_at IS NULL;

-- 0106:skip-backfill
-- #999's meaning, written down: a template-month whose ONLY postings are
-- voided read «not this month». Without this, a posting voided before the
-- deploy would re-open on deploy morning. The month is the readers' own
-- coalesce, so a row with no month (a long-lived test database, #653)
-- groups under its date's month instead of inserting NULL. ON CONFLICT: the
-- test replays this statement on a live database (0099's test idiom).
INSERT INTO recurring_skips (recurring_id, month, reason, created_by, created_at)
SELECT g.recurring_id, g.month,
       'Yangilanishdan oldin bekor qilingan yozuv',
       coalesce(g.voided_by, r.created_by), coalesce(g.voided_at, now())
  FROM (SELECT e.recurring_id,
               coalesce(e.recurring_month, date_trunc('month', e.expense_date)::date) AS month,
               (array_agg(e.voided_by ORDER BY e.voided_at DESC NULLS LAST))[1] AS voided_by,
               max(e.voided_at) AS voided_at
          FROM expenses e
         WHERE e.recurring_id IS NOT NULL
         GROUP BY 1, 2
        HAVING bool_and(e.voided_at IS NOT NULL)) g
  JOIN recurring_expenses r ON r.id = g.recurring_id
ON CONFLICT DO NOTHING;
