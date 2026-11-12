-- AI sotuvchi — «o'zi yuborish», auto-send (docs/AI-SOTUVCHI.md §18.3, his answer of 2026-11-11:
-- «sen aytgandek bolsin faqat 50 talik test bolmasin ozi javob beraversin men bergan tasdiq kop kutib qolmasin»).
--
-- A LAYER over shadow, never a mode: `agent_config.mode` stays 'shadow' (toConfig maps any other value to 'off',
-- and a tg-listen that was not rebuilt would cancel every approved reply), and an eligible reply goes by a MACHINE
-- PRESS of the same ✅ — `decideDraft`, then the existing pump. So nothing existing gains a column (0138's rule,
-- review build-10): three side tables, every reader and writer behind `agentAutoReady()`, and one migration behind
-- everything behaves exactly as today.
--
-- agent_auto_config: the singleton his press arms. Armed = `armed_at` set; the numbers are the design's ⭐
--   (2 minutes of ⏸, 30 a day, 400 characters, 0.80) bounded by CHECKs; the four categories the design may ever
--   open, a subset he chooses. No proof cell and no holdback: his answer removed both.
-- agent_auto_verdicts: ONE row per reply draft the inbound run wrote while this exists — the rehearsal record (the
--   gate's verdict and every reason it refused) AND the send state the minute sweep claims. An ineligible row has
--   no state; the CHECKs say so. It follows its draft (a purge deletes drafts).
-- agent_auto_chats: a chat the layer stays out of until `off_until` (his 👎, a «botmisiz?» after an auto reply).
--
-- gsr_ai_reader (0080, allowlist default-deny) is granted NOTHING on these tables (stated): they hold the
-- owner's decisions about customer conversations. Every users FK has no ON DELETE (users are deactivated, never
-- deleted — the audit FK).

CREATE TABLE "agent_auto_config" (
  "id" smallint PRIMARY KEY DEFAULT 1,
  "armed_at" timestamptz,
  "armed_by" uuid REFERENCES "users"("id"),
  "hold_sec" integer NOT NULL DEFAULT 120,
  "per_day" integer NOT NULL DEFAULT 30,
  "max_chars" integer NOT NULL DEFAULT 400,
  "min_confidence" numeric(3, 2) NOT NULL DEFAULT 0.80,
  "categories" text[] NOT NULL DEFAULT '{greeting,qualification,faq,status}',
  "disarmed_at" timestamptz,
  "disarm_reason" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_auto_config_singleton_check" CHECK ("id" = 1),
  CONSTRAINT "agent_auto_config_armed_check" CHECK (("armed_at" IS NULL) = ("armed_by" IS NULL)),
  CONSTRAINT "agent_auto_config_hold_check" CHECK ("hold_sec" BETWEEN 30 AND 600),
  CONSTRAINT "agent_auto_config_day_check" CHECK ("per_day" BETWEEN 1 AND 80),
  CONSTRAINT "agent_auto_config_chars_check" CHECK ("max_chars" BETWEEN 50 AND 1000),
  CONSTRAINT "agent_auto_config_confidence_check" CHECK ("min_confidence" >= 0.5 AND "min_confidence" <= 1),
  -- Never price, complaint or other (§18.3), and at least one — the writer refuses an empty set too.
  CONSTRAINT "agent_auto_config_categories_check" CHECK (
    "categories" <@ ARRAY['greeting', 'qualification', 'faq', 'status']::text[] AND cardinality("categories") >= 1
  )
);
--> statement-breakpoint
INSERT INTO "agent_auto_config" ("id") VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE "agent_auto_verdicts" (
  "draft_id" uuid PRIMARY KEY REFERENCES "agent_drafts"("id") ON DELETE CASCADE,
  "manager_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "peer_id" bigint NOT NULL,
  "eligible" boolean NOT NULL,
  "reasons" text[] NOT NULL DEFAULT '{}',
  "category" text,
  "confidence" numeric(3, 2),
  "digest" text,
  "state" text,
  "due_at" timestamptz,
  "claimed_at" timestamptz,
  "pressed_at" timestamptz,
  "stopped_at" timestamptz,
  "stopped_by" uuid REFERENCES "users"("id"),
  "outcome" text,
  "feedback" text,
  "feedback_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_auto_verdicts_state_check"
    CHECK ("state" IS NULL OR "state" IN ('waiting', 'pressing', 'pressed', 'stopped', 'refused', 'gone')),
  -- An ineligible row is the rehearsal's record only: no state, no time it is due.
  CONSTRAINT "agent_auto_verdicts_eligible_check" CHECK (("state" IS NULL) = (NOT "eligible")),
  CONSTRAINT "agent_auto_verdicts_due_check" CHECK (("state" IS NULL) = ("due_at" IS NULL)),
  CONSTRAINT "agent_auto_verdicts_confidence_check"
    CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)),
  CONSTRAINT "agent_auto_verdicts_feedback_check" CHECK ("feedback" IS NULL OR "feedback" IN ('bad')),
  CONSTRAINT "agent_auto_verdicts_feedback_at_check" CHECK (("feedback" IS NULL) = ("feedback_at" IS NULL)),
  -- 👎 is about a reply the machine SENT.
  CONSTRAINT "agent_auto_verdicts_feedback_sent_check" CHECK ("feedback" IS NULL OR "state" = 'pressed')
);
--> statement-breakpoint
-- The minute sweep's claim: only the rows it may press or reclaim.
CREATE INDEX "agent_auto_verdicts_due_idx" ON "agent_auto_verdicts" ("due_at") WHERE "state" IN ('waiting', 'pressing');
--> statement-breakpoint
-- A chat's run of auto replies (the streak) and its recent presses (the block and «botmisiz?» step-downs).
CREATE INDEX "agent_auto_verdicts_chat_idx" ON "agent_auto_verdicts" ("manager_user_id", "peer_id", "created_at" DESC);
--> statement-breakpoint
-- The day's count and the page's «Yuborilganlar».
CREATE INDEX "agent_auto_verdicts_pressed_idx" ON "agent_auto_verdicts" ("pressed_at") WHERE "state" = 'pressed';
--> statement-breakpoint
CREATE TABLE "agent_auto_chats" (
  "manager_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "peer_id" bigint NOT NULL,
  "off_until" timestamptz NOT NULL,
  "reason" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("manager_user_id", "peer_id")
);
