-- The owner's monthly plan (2026-09-25, his answer 5a: «har oy maqsad
-- kiritasiz, dashboard reja-fakt ko'rsatadi»).
--
-- One row per MONTH, keyed on the month's first day so a plan cannot exist
-- twice for one month (the CHECK makes a mid-month date a refusal, not a
-- second row). Both figures are nullable on purpose: a month with only a
-- revenue plan has no profit plan, and the dashboard must say «reja yo'q»
-- rather than compare against $0. The profit plan is the P&L's NET profit
-- (revenue − cargo costs − overheads by their dates), the only profit that has
-- a month; it may be negative (a planned loss month is a real plan).
--
-- 'NaN'::numeric answers TRUE to `>= 0` (round 110's lesson), so every money
-- column excludes it by name.

CREATE TABLE business_targets (
  month date PRIMARY KEY,
  revenue_usd numeric(14, 2),
  net_profit_usd numeric(14, 2),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_targets_month_check CHECK (month = date_trunc('month', month)::date),
  CONSTRAINT business_targets_revenue_check
    CHECK (revenue_usd IS NULL OR (revenue_usd >= 0 AND revenue_usd <> 'NaN'::numeric)),
  CONSTRAINT business_targets_profit_check
    CHECK (net_profit_usd IS NULL OR net_profit_usd <> 'NaN'::numeric)
);
