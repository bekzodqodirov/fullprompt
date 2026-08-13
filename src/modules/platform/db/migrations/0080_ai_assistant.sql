-- The AI round (owner: «sistemamizga AI ulay olamizmi, malumotlarni tahlil
-- qilib savollarga javob beradgan»). Three pieces: the question ledger (it is
-- the audit AND the daily cap's counter, so it must survive restarts and be
-- shared by the bot and the web), the analyst's read-only Postgres role — the
-- confidentiality fence under model-written SQL — and the one money view that
-- raw SQL is allowed to aggregate.

CREATE TABLE ai_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  surface text NOT NULL CHECK (surface IN ('bot', 'web')),
  question text NOT NULL,
  answer text,
  -- NULL while in flight: the row is INSERTED before the model is called, so
  -- the cap counts attempts and a crash mid-question still spends a slot.
  ok boolean,
  tool_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_questions_user_day_idx ON ai_questions (user_id, created_at);

-- The ONE money figure model-written SQL may aggregate. It restates
-- clientBalanceUsd() and an equivalence test pins the two together; every
-- other money question goes through the report functions (cash_flow /
-- company_balance tools), because deferrals, partner legs, FX and retired
-- tills make a raw-column total confidently wrong.
CREATE VIEW v_client_balance_usd AS
SELECT client_id,
       round(coalesce(sum(CASE WHEN type = 'charge' THEN amount_usd ELSE -amount_usd END), 0), 2) AS balance_usd
FROM client_transactions
WHERE voided_at IS NULL
GROUP BY client_id;

-- The reader role. CREATE ROLE is CLUSTER-wide — gsr_dev/gsr_ci/gsr_test
-- share one local cluster — so only the CREATE is guarded. Every GRANT below
-- stays OUTSIDE the guard and unconditional: grants are per-DATABASE ACL
-- rows, and each database's own migration run must write its own.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gsr_ai_reader') THEN
    CREATE ROLE gsr_ai_reader NOLOGIN;
  END IF;
END
$$;

-- dblink/fdw would let a vetted SELECT connect BACK as the app's own user and
-- read around every grant below. None is installed anywhere this runs; refuse
-- loudly if one ever appears rather than fencing around it.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_extension WHERE extname IN ('dblink', 'postgres_fdw', 'file_fdw')) THEN
    RAISE EXCEPTION 'gsr_ai_reader fence: a dblink/fdw extension is installed';
  END IF;
END
$$;

-- SET ROLE needs membership the day the app stops connecting as a superuser.
GRANT gsr_ai_reader TO CURRENT_USER;

-- The ALLOWLIST — default deny. A table not named here (audit_log with its
-- before/after blobs, settings, every credential table, ai_questions itself,
-- and anything a LATER migration creates) is invisible to the role until a
-- migration says otherwise. That is the fail-closed direction on purpose.
GRANT SELECT ON
  warehouses, clients, receipts, receipt_lots, boxes, crates, batches,
  box_movements, scan_events, load_plans, load_plan_versions, load_plan_lines,
  handovers, expected_arrivals, client_notices, attachments,
  cost_types, cost_entries, cost_allocations, expenses, expense_categories,
  recurring_expenses, money_accounts, account_transfers, client_transactions,
  fx_rates, currencies, partners, partner_types, partner_transactions,
  issue_approvals, leads, lead_stages, deals, deal_stages, deal_lines,
  lead_intakes, inbound_routes, lead_field_map, lost_reasons, crm_activities,
  crm_people, tasks, task_types, tnved_assignments, product_dictionary,
  truck_presets, driver_positions, call_logs, tg_messages, tg_chat_rules,
  custom_entities, custom_fields, custom_field_values, custom_records,
  calc_requests, automation_rules, automation_fires,
  v_client_balance_usd
TO gsr_ai_reader;

-- Column grants where the row is business data and one column is a
-- credential: SELECT * on these errors, and the model retries with names.
GRANT SELECT (id, phone, username, full_name, locale, active, created_at, updated_at, muted_notification_types, inbound_rota)
  ON users TO gsr_ai_reader;
GRANT SELECT (id, name, sort_order, active, created_at, key)
  ON lead_sources TO gsr_ai_reader;
