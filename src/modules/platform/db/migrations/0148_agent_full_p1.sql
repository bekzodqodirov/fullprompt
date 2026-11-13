-- The full AI seller, part 1 (spec SPEC-P1-v2 §1.5, §2, §3, §5): the price as a fifth auto category, no daily
-- count on the auto layer (his «7 chegara qoyma»), the account-protection limits editable (his «4 hozircha
-- qolsin … o'zgartirish imkoni»), his lessons («hato qilgan joyini men aytib ketay va u ozi organib boradgan
-- bolsin»), and the bot's two new one-text waits.
--
-- NOTHING EXISTING GAINS A COLUMN (0138's rule, 0145's): `readAgentConfig` and `readAutoConfig` are a select()
-- of every declared column, behind probes that answer TRUE one migration behind — a new declared column there
-- would be a 42703 in every reader on deploy morning, the listener's send step among them. So the caps live on a
-- side table of their own, read behind `agentFullP1Ready()`; every 0148 writer asks it first and is refused in
-- words, never a raw 23502/23514, while the code runs ahead of this file.
--
-- gsr_ai_reader (0080, allowlist default-deny) is granted NOTHING on the two new tables (stated): they hold the
-- owner's instructions to the AI and his account's send limits. Every users FK has no ON DELETE (users are
-- deactivated, never deleted — the audit FK).

-- (1) The price as a fifth category the layer may open (§1.5). The CHECK admits it; the STORED row is NOT changed:
-- his Q1 decides what the AI MAY say by itself, and arming has always been his press (§18.3) — the page's fifth
-- box ships unticked.
ALTER TABLE "agent_auto_config" DROP CONSTRAINT "agent_auto_config_categories_check";
--> statement-breakpoint
ALTER TABLE "agent_auto_config" ADD CONSTRAINT "agent_auto_config_categories_check" CHECK (
  "categories" <@ ARRAY['greeting', 'qualification', 'faq', 'status', 'price']::text[] AND cardinality("categories") >= 1
);
--> statement-breakpoint
-- (2) The auto layer's daily count: none (§5.1, his «7 chegara qoyma»). NULL = no cap; a number he types stays
-- bounded. The stored row becomes NULL, and — every other change of this table is audited — so does this one.
ALTER TABLE "agent_auto_config" ALTER COLUMN "per_day" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_auto_config" ALTER COLUMN "per_day" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "agent_auto_config" DROP CONSTRAINT "agent_auto_config_day_check";
--> statement-breakpoint
ALTER TABLE "agent_auto_config" ADD CONSTRAINT "agent_auto_config_day_check"
  CHECK ("per_day" IS NULL OR "per_day" BETWEEN 1 AND 1000);
--> statement-breakpoint
-- The audit row first, reading the value it replaces (auto-send `AUTO_AUDIT_ID`, the layer's one entity id).
INSERT INTO "audit_log" ("actor_id", "entity_type", "entity_id", "action", "before", "after")
SELECT NULL, 'agent_auto_config', '00000000-0000-0000-0000-000000000143'::uuid, 'update',
       jsonb_build_object('perDay', "per_day"), jsonb_build_object('perDay', NULL, 'via', '0148')
  FROM "agent_auto_config" WHERE "id" = 1 AND "per_day" IS NOT NULL;
--> statement-breakpoint
UPDATE "agent_auto_config" SET "per_day" = NULL, "updated_at" = now() WHERE "id" = 1 AND "per_day" IS NOT NULL;
--> statement-breakpoint
-- (3) His lessons (§3). An INSTRUCTION, never a source: a figure in one is no G1 source and can never put a
-- figure into a reply. Written in the bot it waits for his «✅ Saqlash» (`confirmed_at` NULL = not in the prompt
-- yet; `confirm_token` the one-time token that press carries, the 📌 pattern); the page's save is itself the
-- confirmation. A lesson carries no customer's details — the writer refuses them, as a general fact's — so it
-- SURVIVES a chat's purge: the purge deletes the draft it was given on and `draft_id` goes NULL (a rule he
-- believes the AI follows is never dropped because one chat was marked «🚫 Shaxsiy»).
CREATE TABLE "agent_lessons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "text" text NOT NULL,
  "draft_id" uuid REFERENCES "agent_drafts"("id") ON DELETE SET NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "active" boolean NOT NULL DEFAULT true,
  "confirmed_at" timestamptz,
  "confirm_token" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_lessons_text_check" CHECK (length(btrim("text")) > 0 AND length("text") <= 500),
  -- The token is the unconfirmed lesson's alone: a confirmed one has nothing left to press.
  CONSTRAINT "agent_lessons_token_check" CHECK ("confirm_token" IS NULL OR "confirmed_at" IS NULL)
);
--> statement-breakpoint
-- The prompt's read: the active, confirmed lessons, newest first, in a stable order (§3.3).
CREATE INDEX "agent_lessons_prompt_idx" ON "agent_lessons" ("created_at" DESC, "id" DESC)
  WHERE "active" AND "confirmed_at" IS NOT NULL;
--> statement-breakpoint
-- (4) The account-protection limits (§5.2) and the tariff's confirmation (§1.6) — a singleton side table, never
-- columns on agent_config or agent_auto_config (above). NULL = today's constant (`AGENT_LIMITS.perDay` 80,
-- `perHour` 20). The bounds are the human queue's own (crm/telegram-send `DEFAULT_LIMITS`: 200 a day; 12 a
-- minute, so at most 100 an hour): the agent may never be the reason the account hits a ceiling the human bridge
-- respects (tests/unit/agent-send-step.test.ts reads them here).
-- `tariff_confirmed_at`: his ✅ on the China column as it stands — an /admin/tarif write after it holds estimate
-- replies until he looks (§1.6 `tariff_unconfirmed`). `tariff_notice_for`: the website table's `validThrough`
-- whose 14-day notice was claimed — once per expiry (§1.6).
CREATE TABLE "agent_send_caps" (
  "id" smallint PRIMARY KEY DEFAULT 1,
  "day_cap" integer,
  "hour_cap" integer,
  "tariff_confirmed_at" timestamptz,
  "tariff_notice_for" date,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" uuid REFERENCES "users"("id"),
  CONSTRAINT "agent_send_caps_singleton_check" CHECK ("id" = 1),
  CONSTRAINT "agent_send_caps_day_check" CHECK ("day_cap" IS NULL OR "day_cap" BETWEEN 1 AND 200),
  CONSTRAINT "agent_send_caps_hour_check" CHECK ("hour_cap" IS NULL OR "hour_cap" BETWEEN 1 AND 100)
);
--> statement-breakpoint
INSERT INTO "agent_send_caps" ("id") VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- (5) The bot's two new one-text waits (§2.2 «✍️ Savolga javob», §3.1 «📝 Tuzatish»). Waits are DURABLE in
-- production (`setDurableWaits(true)`) and a refused INSERT is swallowed with one warning, so a kind missing
-- here would pass every test and lose the wait at the next deploy. Re-made the way 0141 and 0146 re-made it —
-- every existing kind kept, 0146's 'receipt_files' (a prixod's file collection) among them.
ALTER TABLE "telegram_chat_waits" DROP CONSTRAINT "telegram_chat_waits_kind_check";
--> statement-breakpoint
ALTER TABLE "telegram_chat_waits" ADD CONSTRAINT "telegram_chat_waits_kind_check" CHECK ("kind" IN (
  'task', 'staff_entry', 'ad_visit', 'cabinet_link', 'agent_edit', 'agent_price', 'agent_code', 'burst',
  'receipt_files', 'agent_answer', 'agent_lesson'
));
