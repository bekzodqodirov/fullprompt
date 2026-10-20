-- Jamoa guruhi (the owner, 2026-10-20: «telegram botni gurux chat groupga qoshsa … client code ochilganda
-- … hammani oldida maqtaydigan gift … lead yutilganda … har shanba soat 18:00 da hodimlar reytingi», answers
-- «3. 2 3 gif yuklab qoyaylik zerkarli bolmasin tabriklash ham / qolgani sen aytkandek bolsin»).
-- Three tables, all new, nothing existing altered.
--
-- staff_group_chats: every Telegram GROUP the bot was added to. The ONE row with active_from set is THE
--   staff group (a partial UNIQUE index allows one) — a row and never a setting, the price channel's reason:
--   /admin/settings renders every key as an editable input, which would be a door around the adoption rule.
--   A group added by a stranger is recorded with no adder and never becomes active by itself.
--
-- staff_group_posts: ONE row per thing said in the group — a celebration, the Saturday rating, the month's
--   champion, a test. The claim is the UNIQUE dedupe_key (INSERT … ON CONFLICT DO NOTHING), so a redelivered
--   job, a re-won lead or a second press can never praise anybody twice in front of everybody (#48). A rating
--   row keeps the STANDINGS it posted, so streaks and records are read from what people saw, never recomputed
--   from cargo that moved since.
--
-- staff_group_media: the GIFs and photos the admin uploaded (ordinary `attachments` rows of type
--   staff_group_media, so the off-site copy needs no new machinery) — Telegram's file id for those bytes, typed
--   by the method that minted it, and when each was last shown, which is the rotation.
--
-- gsr_ai_reader (0080, allowlist default-deny) is granted NOTHING on these three tables (stated).
-- The chats' users FKs have no ON DELETE: users are deactivated, never deleted (the audit FK). A post's
-- subject_user_id is SET NULL instead: every lead won and every first prixod writes a post row (skipped while no
-- group is connected), and a test suite that deletes the fixture user behind them must not be refused by a
-- celebration nobody saw.
CREATE TABLE "staff_group_chats" (
  "chat_id" bigint PRIMARY KEY,
  "chat_type" text NOT NULL,
  "title" text NOT NULL DEFAULT '',
  "status" text NOT NULL,
  "can_post" boolean,
  "member_count" integer,
  "added_by_user_id" uuid REFERENCES "users"("id"),
  "active_from" timestamptz,
  "active_by_user_id" uuid REFERENCES "users"("id"),
  "vetted_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "staff_group_chats_type_check" CHECK ("chat_type" IN ('group','supergroup')),
  CONSTRAINT "staff_group_chats_status_check"
    CHECK ("status" IN ('creator','administrator','member','restricted','left','kicked')),
  CONSTRAINT "staff_group_chats_active_check"
    CHECK (("active_from" IS NULL) = ("active_by_user_id" IS NULL))
);
--> statement-breakpoint
-- At most one active staff group.
CREATE UNIQUE INDEX "staff_group_chats_one_active" ON "staff_group_chats" ((true)) WHERE "active_from" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "staff_group_posts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL,
  "dedupe_key" text NOT NULL,
  "subject_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "html" text NOT NULL,
  "media_attachment_id" uuid REFERENCES "attachments"("id") ON DELETE SET NULL,
  "standings" jsonb,
  "status" text NOT NULL DEFAULT 'pending',
  "skip_reason" text,
  "chat_id" bigint,
  "message_id" integer,
  "attempts" integer NOT NULL DEFAULT 0,
  "not_before" timestamptz,
  "claimed_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "sent_at" timestamptz,
  CONSTRAINT "staff_group_posts_dedupe_unique" UNIQUE ("dedupe_key"),
  CONSTRAINT "staff_group_posts_kind_check"
    CHECK ("kind" IN ('client','won','first_cargo','rating','champion','test')),
  CONSTRAINT "staff_group_posts_status_check"
    CHECK ("status" IN ('pending','sending','sent','failed','skipped')),
  CONSTRAINT "staff_group_posts_skip_check" CHECK (
    ("status" = 'skipped') = ("skip_reason" IS NOT NULL) AND
    ("skip_reason" IS NULL OR "skip_reason" IN ('no_group','stale','group_changed'))
  ),
  CONSTRAINT "staff_group_posts_sent_check"
    CHECK ("status" <> 'sent' OR ("message_id" IS NOT NULL AND "chat_id" IS NOT NULL AND "sent_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "staff_group_posts_pending_idx" ON "staff_group_posts" ("created_at") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX "staff_group_posts_kind_idx" ON "staff_group_posts" ("kind", "created_at" DESC);
--> statement-breakpoint
CREATE TABLE "staff_group_media" (
  "attachment_id" uuid PRIMARY KEY REFERENCES "attachments"("id") ON DELETE CASCADE,
  "telegram_file_id" text,
  "telegram_sent_as" text,
  "last_used_at" timestamptz,
  CONSTRAINT "staff_group_media_sent_as_check"
    CHECK ("telegram_sent_as" IS NULL OR "telegram_sent_as" IN ('animation','photo')),
  CONSTRAINT "staff_group_media_cache_pair_check"
    CHECK (("telegram_file_id" IS NULL) = ("telegram_sent_as" IS NULL))
);
