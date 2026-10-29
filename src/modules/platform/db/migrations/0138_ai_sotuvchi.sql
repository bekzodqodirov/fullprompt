-- AI sotuvchi, phase 1 (docs/AI-SOTUVCHI.md §15-§17, the review docs/AI-SOTUVCHI-REVIEW.md). The owner,
-- 2026-10-23: «Telegram businessdagi bot emas mening shaxsiy account seansimdan ishlatsin ai va ban havfini
-- minimum qilsin». An AI drafts replies to customers who write to HIS personal Telegram account, he approves
-- every one in the staff bot (shadow mode), and the listener that already holds his session sends it.
--
-- NOTHING EXISTING GAINS A COLUMN (review build-10). Every new fact lives in a new table, so on a database one
-- migration behind every existing whole-row read — `db.select().from(tgOutbox)`, `db.query.tgMessages…` —
-- names exactly the columns it names today. The one change to an existing object is the CHECK on
-- telegram_chat_waits (three more one-text waits) and an index on tg_messages.
--
-- agent_outbox, never tg_outbox (review regression-1): an approved AI reply is a row an OLD listener cannot
--   see by construction, and none of tg_outbox's writers, readers, CHECKs or recovery paths change.
-- tg_account_guard: the account's pause (a spam limit or a freeze — every manager's account, his 13 ⭐) and
--   the flood wait Telegram ordered, PERSISTED so a restart cannot forget them (review ban-1/ban-2), plus the
--   stamp a current listener writes so the app can refuse to approve into a pump that will never send.
-- tg_message_flags: a message deleted for both sides, or sent by the customer's own auto-replier — facts about
--   a stored row, kept beside it.
--
-- gsr_ai_reader (0080, allowlist default-deny) is granted NOTHING on these tables (stated): they hold customer
-- conversations, the owner's drafts and the agent's ledger. Every users FK has no ON DELETE (users are
-- deactivated, never deleted — the audit FK); tg_message_flags follows its message (a purge deletes both).

CREATE TABLE "agent_config" (
  "id" smallint PRIMARY KEY DEFAULT 1,
  "mode" text NOT NULL DEFAULT 'off',
  "owner_user_id" uuid REFERENCES "users"("id"),
  "session_exclusive_at" timestamptz,
  "session_exclusive_by" uuid REFERENCES "users"("id"),
  "human_pause_min" integer NOT NULL DEFAULT 120,
  "daily_draft_cap" integer NOT NULL DEFAULT 150,
  "daily_token_cap" integer NOT NULL DEFAULT 3000000,
  "started_at" timestamptz,
  "style_guide" text,
  "style_guide_proposed" text,
  "style_approved_at" timestamptz,
  "style_approved_by" uuid REFERENCES "users"("id"),
  -- His avia rate (2026-10-24 §17.14: «Avia hozir kg uchun 17$ dan»), the one money figure the agent may
  -- multiply that is not the website's table; NULL = avia is not quoted. Edited on /suhbatlar/ai.
  "avia_usd_per_kg" numeric(10, 2) DEFAULT 17,
  "avia_rate_set_at" timestamptz,
  "avia_rate_set_by" uuid REFERENCES "users"("id"),
  "updated_by" uuid REFERENCES "users"("id"),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_config_singleton_check" CHECK ("id" = 1),
  CONSTRAINT "agent_config_avia_check" CHECK (
    "avia_usd_per_kg" IS NULL OR ("avia_usd_per_kg" > 0 AND "avia_usd_per_kg" < 1000 AND "avia_usd_per_kg" <> 'NaN'::numeric)
  ),
  CONSTRAINT "agent_config_mode_check" CHECK ("mode" IN ('off', 'shadow', 'auto')),
  CONSTRAINT "agent_config_pause_check" CHECK ("human_pause_min" BETWEEN 1 AND 10080),
  CONSTRAINT "agent_config_caps_check" CHECK ("daily_draft_cap" >= 0 AND "daily_token_cap" >= 0),
  CONSTRAINT "agent_config_session_check" CHECK (("session_exclusive_at" IS NULL) = ("session_exclusive_by" IS NULL)),
  -- The mode cannot leave 'off' with nobody to speak for, or before the old server's copy of the session is
  -- confirmed gone (review ban-9: a second connection on one key kills it).
  CONSTRAINT "agent_config_on_check" CHECK (
    "mode" = 'off' OR ("owner_user_id" IS NOT NULL AND "session_exclusive_at" IS NOT NULL)
  )
);
--> statement-breakpoint
INSERT INTO "agent_config" ("id") VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE "agent_conversations" (
  "manager_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "peer_id" bigint NOT NULL,
  "locale" text,
  "human_until" timestamptz,
  "muted_at" timestamptz,
  "mute_reason" text,
  "peer_typing_at" timestamptz,
  "stranger_card_at" timestamptz,
  "identity_client_id" uuid REFERENCES "clients"("id"),
  "identity_lead_id" uuid REFERENCES "leads"("id"),
  "identity_strength" text,
  -- Is the peer in the account's own contacts (as the listener last read it)? A stranger card is never sent
  -- for a contact — a friend or a colleague is not a lead (review fit-7). NULL = never read.
  "peer_contact" boolean,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("manager_user_id", "peer_id"),
  CONSTRAINT "agent_conversations_locale_check"
    CHECK ("locale" IS NULL OR "locale" IN ('uz', 'uz_cyrl', 'ru', 'en', 'fa', 'zh')),
  CONSTRAINT "agent_conversations_strength_check"
    CHECK ("identity_strength" IS NULL OR "identity_strength" IN ('phone', 'cabinet', 'rule', 'typed_code', 'lead'))
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "manager_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "peer_id" bigint NOT NULL,
  "trigger" text NOT NULL,
  "anchor_tg_message_id" bigint,
  "attempt" smallint NOT NULL DEFAULT 0,
  "source_key" text,
  "model" text,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "cache_read_tokens" integer NOT NULL DEFAULT 0,
  "cache_write_tokens" integer NOT NULL DEFAULT 0,
  "tool_calls" jsonb NOT NULL DEFAULT '[]',
  "duration_ms" integer,
  "outcome" text NOT NULL DEFAULT 'reserved',
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_runs_trigger_check"
    CHECK ("trigger" IN ('inbound', 'owner_edit', 'calc_answer', 'hand_back', 'style')),
  CONSTRAINT "agent_runs_outcome_check" CHECK ("outcome" IN (
    'reserved', 'draft', 'no_reply', 'notice', 'stood_down', 'refused', 'capped', 'error'
  )),
  CONSTRAINT "agent_runs_tokens_check" CHECK (
    "input_tokens" >= 0 AND "output_tokens" >= 0 AND "cache_read_tokens" >= 0 AND "cache_write_tokens" >= 0
  ),
  CONSTRAINT "agent_runs_anchor_check" CHECK ("trigger" <> 'inbound' OR "anchor_tg_message_id" IS NOT NULL)
);
--> statement-breakpoint
-- One run per inbound anchor and attempt: the debounce's stand-down and a redelivered job meet here (review
-- build-8). Runs that answer the OWNER (his edit, a calc event) are keyed by their own source instead.
CREATE UNIQUE INDEX "agent_runs_inbound_unique"
  ON "agent_runs" ("manager_user_id", "peer_id", "anchor_tg_message_id", "attempt") WHERE "trigger" = 'inbound';
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_source_unique"
  ON "agent_runs" ("manager_user_id", "peer_id", "trigger", "source_key") WHERE "source_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "agent_runs_day_idx" ON "agent_runs" ("created_at");
--> statement-breakpoint
CREATE TABLE "agent_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" uuid REFERENCES "agent_runs"("id"),
  "manager_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "peer_id" bigint NOT NULL,
  "client_id" uuid REFERENCES "clients"("id"),
  "lead_id" uuid REFERENCES "leads"("id"),
  "identity_strength" text,
  "anchor_tg_message_id" bigint NOT NULL,
  "anchor_edited_at" timestamptz,
  "kind" text NOT NULL DEFAULT 'reply',
  "proposed_body" text,
  "final_body" text,
  "gloss_uz" text,
  "language" text,
  "category" text,
  "confidence" numeric(3, 2),
  "next_step" text,
  "policy" jsonb NOT NULL DEFAULT '{}',
  "blocked" boolean NOT NULL DEFAULT false,
  "needs_owner" boolean NOT NULL DEFAULT false,
  "owner_question" text,
  "actions" jsonb NOT NULL DEFAULT '[]',
  "cited_message_ids" jsonb NOT NULL DEFAULT '[]',
  "offer_id" uuid REFERENCES "calc_offers"("id"),
  "status" text NOT NULL DEFAULT 'pending',
  "action_status" text,
  "action_error" text,
  "decided_by" uuid REFERENCES "users"("id"),
  "decided_at" timestamptz,
  -- His 14 «escalation wait 30 min»: when a question the agent put to him (needs_owner) was reminded of
  -- once, unanswered after 30 minutes (final review K30). NULL = never; the sweep's claim is this column.
  "owner_reminded_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_drafts_kind_check" CHECK ("kind" IN ('reply', 'price', 'hand_back')),
  CONSTRAINT "agent_drafts_status_check" CHECK ("status" IN (
    'pending', 'editing', 'approved', 'rejected', 'superseded', 'expired', 'taken_over'
  )),
  CONSTRAINT "agent_drafts_action_check"
    CHECK ("action_status" IS NULL OR "action_status" IN ('pending', 'done', 'failed')),
  CONSTRAINT "agent_drafts_category_check" CHECK ("category" IS NULL OR "category" IN (
    'greeting', 'status', 'faq', 'qualification', 'price', 'complaint', 'other'
  )),
  CONSTRAINT "agent_drafts_language_check"
    CHECK ("language" IS NULL OR "language" IN ('uz', 'uz_cyrl', 'ru', 'en', 'fa', 'zh')),
  CONSTRAINT "agent_drafts_confidence_check" CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)),
  CONSTRAINT "agent_drafts_decided_check" CHECK (("decided_at" IS NULL) = ("decided_by" IS NULL)),
  CONSTRAINT "agent_drafts_json_check" CHECK (
    jsonb_typeof("policy") = 'object' AND jsonb_typeof("actions") = 'array'
    AND jsonb_typeof("cited_message_ids") = 'array'
  )
);
--> statement-breakpoint
-- One live draft per chat: a newer inbound supersedes the pending one (review fit-9).
CREATE UNIQUE INDEX "agent_drafts_live_unique"
  ON "agent_drafts" ("manager_user_id", "peer_id") WHERE "status" IN ('pending', 'editing');
--> statement-breakpoint
CREATE INDEX "agent_drafts_status_idx" ON "agent_drafts" ("status", "created_at");
--> statement-breakpoint
CREATE TABLE "agent_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "draft_id" uuid NOT NULL UNIQUE REFERENCES "agent_drafts"("id"),
  "manager_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "peer_id" bigint NOT NULL,
  "client_id" uuid REFERENCES "clients"("id"),
  "lead_id" uuid REFERENCES "leads"("id"),
  "body" text NOT NULL,
  "random_id" bigint NOT NULL UNIQUE,
  "reply_to_tg_message_id" bigint,
  "answers_tg_message_id" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'agent',
  "step" text NOT NULL DEFAULT 'verify',
  "next_step_at" timestamptz NOT NULL DEFAULT now(),
  "typing_count" smallint NOT NULL DEFAULT 0,
  "read_done" boolean NOT NULL DEFAULT false,
  "queued_by" uuid NOT NULL REFERENCES "users"("id"),
  "queued_at" timestamptz NOT NULL DEFAULT now(),
  -- When the night rule held an approval to the morning (his Q14 ⭐): the approval's age is counted from
  -- here, or a reply approved at 23:00 would be «too old» by the 08:30 it was promised for. NULL = at once.
  "release_at" timestamptz,
  "step_claimed_at" timestamptz,
  "sent_at" timestamptz,
  "tg_message_id" bigint,
  "last_error" text,
  CONSTRAINT "agent_outbox_owner_check" CHECK ("client_id" IS NOT NULL OR "lead_id" IS NOT NULL),
  CONSTRAINT "agent_outbox_body_check" CHECK (length(btrim("body")) > 0 AND length("body") <= 4000),
  CONSTRAINT "agent_outbox_status_check" CHECK ("status" IN (
    'agent', 'sending', 'sent', 'failed', 'cancelled', 'unknown', 'expired'
  )),
  CONSTRAINT "agent_outbox_step_check" CHECK ("step" IN ('verify', 'read', 'typing', 'send')),
  CONSTRAINT "agent_outbox_sent_check" CHECK (("status" = 'sent') = ("sent_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "agent_outbox_queue_idx" ON "agent_outbox" ("manager_user_id", "status", "next_step_at");
--> statement-breakpoint
-- The 🤖 marker and the human-pause test join a stored out row back to the AI row that wrote it.
CREATE INDEX "agent_outbox_message_idx" ON "agent_outbox" ("manager_user_id", "peer_id", "tg_message_id");
--> statement-breakpoint
CREATE TABLE "kb_facts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "scope" text NOT NULL DEFAULT 'general',
  "client_id" uuid REFERENCES "clients"("id"),
  "lead_id" uuid REFERENCES "leads"("id"),
  "kind" text NOT NULL DEFAULT 'fact',
  "question" text,
  "answer" text NOT NULL,
  "locale" text,
  "source" text NOT NULL,
  "source_ref" jsonb,
  "approved_at" timestamptz,
  "approved_by" uuid REFERENCES "users"("id"),
  "uses_count" integer NOT NULL DEFAULT 0,
  "last_used_at" timestamptz,
  "retired_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "kb_facts_scope_check" CHECK ("scope" IN ('general', 'client', 'lead')),
  -- One owner per fact, named by the scope (review leak-2): a lead's fact must never read as a general one.
  CONSTRAINT "kb_facts_general_check" CHECK (("scope" = 'general') = ("client_id" IS NULL AND "lead_id" IS NULL)),
  CONSTRAINT "kb_facts_client_check" CHECK (("scope" = 'client') = ("client_id" IS NOT NULL)),
  CONSTRAINT "kb_facts_lead_check" CHECK (("scope" = 'lead') = ("lead_id" IS NOT NULL)),
  CONSTRAINT "kb_facts_kind_check" CHECK ("kind" IN ('fact', 'policy', 'definition')),
  CONSTRAINT "kb_facts_source_check" CHECK ("source" IN ('owner', 'site', 'seed', 'manual')),
  CONSTRAINT "kb_facts_answer_check" CHECK (length(btrim("answer")) > 0 AND length("answer") <= 2000),
  CONSTRAINT "kb_facts_locale_check"
    CHECK ("locale" IS NULL OR "locale" IN ('uz', 'uz_cyrl', 'ru', 'en', 'fa', 'zh')),
  CONSTRAINT "kb_facts_approved_check" CHECK (("approved_at" IS NULL) = ("approved_by" IS NULL) OR "source" IN ('seed', 'site'))
);
--> statement-breakpoint
CREATE INDEX "kb_facts_text_trgm_idx"
  ON "kb_facts" USING gin ((coalesce("question", '') || ' ' || "answer") gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "kb_facts_owner_idx" ON "kb_facts" ("scope", "client_id", "lead_id") WHERE "retired_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "agent_calc_links" (
  "request_id" uuid PRIMARY KEY REFERENCES "calc_requests"("id"),
  "root_request_id" uuid NOT NULL REFERENCES "calc_requests"("id"),
  "manager_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "peer_id" bigint NOT NULL,
  "draft_id" uuid REFERENCES "agent_drafts"("id"),
  "last_notified_kind" text,
  "last_notified_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "agent_calc_links_root_idx" ON "agent_calc_links" ("root_request_id");
--> statement-breakpoint
CREATE INDEX "agent_calc_links_chat_idx" ON "agent_calc_links" ("manager_user_id", "peer_id");
--> statement-breakpoint
CREATE TABLE "tg_account_guard" (
  "account_id" uuid PRIMARY KEY REFERENCES "tg_accounts"("id") ON DELETE CASCADE,
  "paused_at" timestamptz,
  "pause_reason" text,
  "paused_kind" text,
  "flood_until" timestamptz,
  "agent_pump_at" timestamptz,
  "caught_up_at" timestamptz,
  "cleared_at" timestamptz,
  "cleared_by" uuid REFERENCES "users"("id"),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tg_account_guard_pause_check" CHECK (("paused_at" IS NULL) = ("paused_kind" IS NULL)),
  CONSTRAINT "tg_account_guard_kind_check"
    CHECK ("paused_kind" IS NULL OR "paused_kind" IN ('peer_flood', 'restricted', 'frozen', 'flood_repeat', 'blocks'))
);
--> statement-breakpoint
CREATE TABLE "tg_account_floods" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "tg_accounts"("id") ON DELETE CASCADE,
  "method" text NOT NULL,
  "seconds" integer NOT NULL,
  "source" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tg_account_floods_source_check" CHECK ("source" IN ('sleep', 'raise')),
  CONSTRAINT "tg_account_floods_seconds_check" CHECK ("seconds" >= 0)
);
--> statement-breakpoint
CREATE INDEX "tg_account_floods_recent_idx" ON "tg_account_floods" ("account_id", "at");
--> statement-breakpoint
-- One ledger row per wait: a replay after a database blip carries the same instant (the listener holds the
-- outcome), so it lands on this and inserts nothing — one FLOOD_WAIT never counts as two.
CREATE UNIQUE INDEX "tg_account_floods_once" ON "tg_account_floods" ("account_id", "method", "at");
--> statement-breakpoint
CREATE TABLE "tg_message_flags" (
  "message_id" uuid PRIMARY KEY REFERENCES "tg_messages"("id") ON DELETE CASCADE,
  "deleted_at" timestamptz,
  "auto_sent" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- A delete names message ids, not chats: a private chat's ids are unique inside one account's message box.
CREATE INDEX "tg_messages_manager_message_idx" ON "tg_messages" ("manager_user_id", "tg_message_id");
--> statement-breakpoint
CREATE TABLE "tg_peer_pulls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "manager_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "peer_id" bigint NOT NULL,
  "requested_by" uuid NOT NULL REFERENCES "users"("id"),
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "claimed_at" timestamptz,
  "done_at" timestamptz,
  "stored_count" integer,
  "error" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tg_peer_pulls_open_unique"
  ON "tg_peer_pulls" ("manager_user_id", "peer_id") WHERE "done_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "telegram_chat_waits" DROP CONSTRAINT "telegram_chat_waits_kind_check";
--> statement-breakpoint
ALTER TABLE "telegram_chat_waits" ADD CONSTRAINT "telegram_chat_waits_kind_check" CHECK ("kind" IN (
  'task', 'staff_entry', 'ad_visit', 'cabinet_link', 'agent_edit', 'agent_price', 'agent_code'
));
