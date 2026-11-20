-- The full AI seller, stage 1a «To'siqlar olib tashlanadi» (docs/ai-toliq/qurish/STAGE-0-1A.md §3.1): who the
-- machine tells — chosen on a screen, never in code (design §11.2: «kim — tizimda tanlanadi») — the signals it
-- sends once, and the replies he marks each evening (his 9 a).
--
-- NUMBERED «the next after the journal's tail» (0150 `batches_view`, `when` …129). Another session's open PR holds
-- this same number: whichever of the two merges SECOND renumbers its file, its tag and its `when` to the tail it
-- finds (#605, #1040 — a database migrated past a later `when` skips an earlier one in silence).
--
-- ADDITIVE ONLY: three new tables. It re-makes NO constraint and adds NO column to an existing table, so unlike
-- 0148 it is not one-way: the code one migration behind reads none of these (the probe `agentToliq1aReady`), and
-- rolling back means dropping them. Every CHECK of 0138/0145/0148/0149 is read and left as it stands — the price hold
-- stays `agent_auto_config.hold_sec`, 👎 keeps writing `agent_auto_verdicts.feedback`, the stored kind ticks and the
-- confidence floor are his and untouched (a migration never flips a choice he stored).
--
-- gsr_ai_reader (0080, allowlist default-deny) is granted NOTHING on the three tables (stated): they name staff,
-- chats and his marks on the machine's replies. Users are deactivated, never deleted (the audit FK) — the one
-- ON DELETE CASCADE on users is the designation's: a row that names nobody names nobody.

-- (1) WHO is told, per topic (design §11.2; §3.2). `topic` is a SHAPE, never an enum: a later stage adds a topic as a
-- key in the code registry (`agent/designations.ts` `AGENT_TOPICS`) and four strings — no migration; a stored row
-- whose topic the registry does not know is read by nobody. `rank` is the order on the screen: 1 is the first
-- person (for the «rahbar va o'rinbosar» pair, 1 = rahbar, 2 = o'rinbosar). No row anywhere = the readers' fallback
-- chain, never «nobody» (the alarm reader) and never a wider door (the door reader answers its own rows only).
CREATE TABLE "agent_designations" (
  "topic" text NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "rank" smallint NOT NULL DEFAULT 1,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("topic", "user_id"),
  CONSTRAINT "agent_designations_topic_check" CHECK ("topic" ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT "agent_designations_rank_check" CHECK ("rank" BETWEEN 1 AND 9)
);
--> statement-breakpoint
-- (2) A signal said ONCE (§4.5, §4.3): the row IS the claim — `dedupe_key` is unique, an INSERT … ON CONFLICT DO
-- NOTHING that wrote nothing is a signal already sent (a big cargo once per chat per week, a loop notice once per
-- window). Keyed by the chat (manager, peer), so a purged chat takes its signals with it (`agent/purge.ts`).
-- `lead_id` / `client_id` carry no FK on purpose (#285's shape): a signal is a record of what was said, and a card
-- merged or deleted later must not take the record or refuse the delete.
CREATE TABLE "agent_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "topic" text NOT NULL,
  "manager_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "peer_id" bigint NOT NULL,
  "lead_id" uuid,
  "client_id" uuid,
  "facts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "dedupe_key" text NOT NULL UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "agent_signals_chat_idx" ON "agent_signals" ("manager_user_id", "peer_id");
--> statement-breakpoint
-- (3) The evening sample (his 9 a, «har kuni kechqurun 10 tasini belgilaydi»): at most ten of the day's replies the
-- machine sent, each marked 👍 / 👎 by a person. One row per (day, draft); a purged chat's drafts take their rows
-- with them (CASCADE, and the purge names the table). A mark is written with its moment, never one without the
-- other. 👍 lives HERE; 👎 is also written where it has always been (`agent_auto_verdicts.feedback`, 0145), which
-- keeps that CHECK as it is.
CREATE TABLE "agent_samples" (
  "day" date NOT NULL,
  "draft_id" uuid NOT NULL REFERENCES "agent_drafts"("id") ON DELETE CASCADE,
  "manager_user_id" uuid NOT NULL,
  "peer_id" bigint NOT NULL,
  "pos" smallint NOT NULL,
  "mark" text,
  "marked_by" uuid REFERENCES "users"("id"),
  "marked_at" timestamptz,
  PRIMARY KEY ("day", "draft_id"),
  CONSTRAINT "agent_samples_mark_check" CHECK ("mark" IS NULL OR "mark" IN ('good', 'bad')),
  CONSTRAINT "agent_samples_marked_check" CHECK (("mark" IS NULL) = ("marked_at" IS NULL))
);
--> statement-breakpoint
-- The cascade from a purged draft looks its rows up by the draft alone (the primary key leads with the day).
CREATE INDEX "agent_samples_draft_idx" ON "agent_samples" ("draft_id");
