-- F (the owner, 2026-10-07, answers F1-F10 a, F9 b): the bot posts every given price into the staff's
-- private Telegram channel. Three tables, all new, nothing existing altered.
--
-- price_channel_chats: every channel a SETTINGS ADMIN made the bot an administrator of (my_chat_member) — a
--   stranger's channel is never recorded. The ONE row with connected_at set is THE channel; there is no setting
--   (the settings screen would be a door around the vetting). Vetting results live here too.
--
-- price_channel_posts: ONE row per given price — the claim (dedupe_key, whose meaning the CHECK owns) and the
--   record of what was posted, including the post's projection (`view`) so a correction re-renders the same words.
--
-- price_channel_members: who the BOT admitted, per channel.
--
-- gsr_ai_reader (0080, allowlist default-deny) is granted NOTHING on these three tables (stated).
-- The users FKs have no ON DELETE: users are deactivated, never deleted (the audit FK).
CREATE TABLE "price_channel_chats" (
  "chat_id" bigint PRIMARY KEY,
  "title" text NOT NULL DEFAULT '',
  "username" text,
  "status" text NOT NULL,
  "rights" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "admins" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "member_count" integer,
  "added_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "connected_at" timestamptz,
  "connected_by_user_id" uuid REFERENCES "users"("id"),
  "vetted_at" timestamptz,
  "invite_link" text,
  "last_error" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "price_channel_chats_status_check"
    CHECK ("status" IN ('creator','administrator','member','restricted','left','kicked')),
  CONSTRAINT "price_channel_chats_connected_check"
    CHECK (("connected_at" IS NULL) = ("connected_by_user_id" IS NULL))
);
--> statement-breakpoint
-- At most one connected channel.
CREATE UNIQUE INDEX "price_channel_chats_one_connected" ON "price_channel_chats" ((true)) WHERE "connected_at" IS NOT NULL;
--> statement-breakpoint
-- ON DELETE CASCADE to the calculation: every seal in every test file writes a `skipped/no_channel` row, and the
-- integration suites delete their requests in cleanup — a RESTRICT FK would turn unrelated files red.
CREATE TABLE "price_channel_posts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL,
  "request_id" uuid NOT NULL REFERENCES "calc_requests"("id") ON DELETE CASCADE,
  "version_id" uuid REFERENCES "calc_versions"("id") ON DELETE CASCADE,
  "dedupe_key" text NOT NULL,
  "chat_id" bigint,
  "status" text NOT NULL,
  "skip_reason" text,
  "view" jsonb,
  "carrier" text,
  "message_id" integer,
  "reply_to_message_id" integer,
  "photo_count" smallint NOT NULL DEFAULT 0,
  "marked_state" text,
  "marked_at" timestamptz,
  "mark_claimed_at" timestamptz,
  "mark_error" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "not_before" timestamptz,
  "claimed_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "sent_at" timestamptz,
  CONSTRAINT "price_channel_posts_dedupe_unique" UNIQUE ("dedupe_key"),
  CONSTRAINT "price_channel_posts_kind_check" CHECK (
    ("kind" = 'seal' AND "version_id" IS NOT NULL AND "dedupe_key" = 'seal:' || "version_id"::text) OR
    ("kind" = 'answer' AND "version_id" IS NULL AND "dedupe_key" = 'answer:' || "request_id"::text)
  ),
  CONSTRAINT "price_channel_posts_status_check"
    CHECK ("status" IN ('pending','sending','sent','failed','skipped')),
  CONSTRAINT "price_channel_posts_skip_check" CHECK (
    ("status" = 'skipped') = ("skip_reason" IS NOT NULL) AND
    ("skip_reason" IS NULL OR "skip_reason" IN ('no_channel','discount','band_override','channel_changed','stale'))
  ),
  CONSTRAINT "price_channel_posts_sent_check" CHECK (
    "status" <> 'sent' OR ("message_id" IS NOT NULL AND "carrier" IS NOT NULL AND "view" IS NOT NULL AND "chat_id" IS NOT NULL)
  ),
  CONSTRAINT "price_channel_posts_carrier_check" CHECK ("carrier" IS NULL OR "carrier" IN ('text','caption')),
  CONSTRAINT "price_channel_posts_mark_check"
    CHECK ("marked_state" IS NULL OR "marked_state" IN ('open','sealed','answered','returned','unpriced'))
);
--> statement-breakpoint
CREATE INDEX "price_channel_posts_pending_idx" ON "price_channel_posts" ("created_at") WHERE "status" IN ('pending','sending');
--> statement-breakpoint
CREATE INDEX "price_channel_posts_unsettled_idx" ON "price_channel_posts" ("request_id")
  WHERE "status" = 'sent' AND ("marked_state" IS NULL OR "marked_state" = 'open');
--> statement-breakpoint
CREATE INDEX "price_channel_posts_request_idx" ON "price_channel_posts" ("request_id", "created_at");
--> statement-breakpoint
-- Who the BOT admitted, PER CHANNEL — a person admitted to an old channel A and later to B is two rows, and the
-- sweep removes them from both.
CREATE TABLE "price_channel_members" (
  "chat_id" bigint NOT NULL,
  "tg_user_id" bigint NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "approved_at" timestamptz NOT NULL DEFAULT now(),
  "removed_at" timestamptz,
  "remove_reason" text,
  "last_error" text,
  CONSTRAINT "price_channel_members_pk" PRIMARY KEY ("chat_id", "tg_user_id"),
  CONSTRAINT "price_channel_members_reason_check" CHECK (
    ("removed_at" IS NULL) = ("remove_reason" IS NULL) AND
    ("remove_reason" IS NULL OR "remove_reason" IN ('inactive','unlinked','relinked','left'))
  )
);
--> statement-breakpoint
CREATE INDEX "price_channel_members_live_idx" ON "price_channel_members" ("user_id") WHERE "removed_at" IS NULL;
