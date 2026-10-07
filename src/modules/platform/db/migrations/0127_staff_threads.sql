-- 0127 staff threads (the owner's E answers, 2026-10-07): the internal Q&A
-- lives on the work's own card, a Telegram reply lands back on that card, and
-- the dock lists the threads a person is in.
--
-- A thread is a card's notes — every message is an ordinary crm_activities
-- row, so the lenta, the history, the attachment gate and the AI keep reading
-- one table. A calculation's Q&A is a TAG on those notes (calc_request_id),
-- written on the request's card of the moment and read by the tag, because a
-- request follows a won lead to its deal while the notes stay on the lead. A
-- note that came from Telegram carries its source message — the pair is both
-- the provenance the bubble prints and the key that refuses a second landing
-- of one re-delivered update. «Unread» is derived from the notes and a
-- per-viewer read mark, never stored as a counter.
--
-- The three crm_activities columns are deliberately NOT declared on the
-- drizzle table this release: drizzle names every declared column in every
-- INSERT, every bare RETURNING and every whole-row select, and those are every
-- note writer in the app — on a database one migration behind they would all
-- fail with 42703 (#472). They are written by one raw writer and read through
-- to_jsonb(row) everywhere else.

-- A note may be about ONE calculation (E5 a): read by this tag on both cards a won lead splits into.
ALTER TABLE "crm_activities" ADD COLUMN "calc_request_id" uuid
  REFERENCES "calc_requests"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- The Telegram message a reply landed from: the provenance AND the idempotency key.
ALTER TABLE "crm_activities" ADD COLUMN "tg_chat_id" bigint;
--> statement-breakpoint
ALTER TABLE "crm_activities" ADD COLUMN "tg_message_id" bigint;
--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_tg_pair_check"
  CHECK (("tg_chat_id" IS NULL) = ("tg_message_id" IS NULL));
--> statement-breakpoint
-- Only a NOTE comes from Telegram. Deliberately no CHECK spans calc_request_id: ON DELETE SET NULL
-- cannot coexist with a CHECK on the FK column (#809); the writer is the only place it is set.
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_tg_note_check"
  CHECK ("tg_message_id" IS NULL OR "kind" = 'note');
--> statement-breakpoint
CREATE INDEX "crm_activities_calc_idx" ON "crm_activities" ("calc_request_id", "happened_at")
  WHERE "calc_request_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_activities_tg_unique" ON "crm_activities" ("tg_chat_id", "tg_message_id")
  WHERE "tg_message_id" IS NOT NULL;
--> statement-breakpoint
-- «Threads I wrote in» for the dock.
CREATE INDEX "crm_activities_author_idx" ON "crm_activities" ("created_by", "happened_at")
  WHERE "kind" = 'note';
--> statement-breakpoint
-- The Telegram reply door resolves a replied-to message to the person's OWN
-- sent ping by the message id the drain stored (payload.tg), with no age
-- window. Measured on a production-shaped table (680 000 rows, one seller
-- holding 50 000): 23 ms through notifications_user_idx and a payload filter
-- on every one of his rows, 0.1 ms through this; built in 0.5 s.
CREATE INDEX "notifications_tg_reply_idx" ON "notifications" ("user_id", (("payload" -> 'tg' ->> 'messageId')))
  WHERE "channel" = 'telegram' AND "status" = 'sent';
--> statement-breakpoint
-- The dock's «threads I was pinged about»: the newest thread pings of ONE person. Measured
-- on the same table: the statement read all 50 000 of the seller's rows through
-- notifications_user_idx (110 ms at one ping in ten, 230 ms at three in five); bounded
-- and through this, 9.4 ms and 6.6 ms. Built in 0.15-0.2 s.
-- The list is the code's THREAD_PING_TYPES (thread.ts writes it as literals so a
-- prepared statement's generic plan can still prove this predicate).
CREATE INDEX "notifications_thread_idx" ON "notifications" ("user_id", "created_at")
  WHERE "type" IN ('InternalNote', 'MentionedInNote', 'CalcThread');
--> statement-breakpoint
CREATE TABLE "thread_reads" (
  -- Per-viewer state with no history value: a user row deleted (fixtures do) takes its marks with it.
  -- Production deactivates people and never deletes them, so this costs nothing there.
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "thread_kind" text NOT NULL,
  "thread_id" uuid NOT NULL,
  "read_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "thread_reads_pk" PRIMARY KEY ("user_id", "thread_kind", "thread_id"),
  -- Round 2 widens this with 'receipt','batch' (a CHECK widening, like 0125).
  CONSTRAINT "thread_reads_kind_check" CHECK ("thread_kind" IN ('lead', 'deal', 'client', 'calc'))
);
--> statement-breakpoint
-- E8 a: «Ichki yozishmalar» is its own mute group. A list saved since 2026-07-28 holds the two moved
-- types BY NAME and would stay muted under an unticked box; strip them so every profile tells the truth.
-- An «all» list is exactly ['all'] (the profile is its only writer) and holds neither name.
UPDATE "users"
   SET "muted_notification_types" = "muted_notification_types" - 'InternalNote' - 'MentionedInNote'
 WHERE jsonb_typeof("muted_notification_types") = 'array'
   AND ("muted_notification_types" ? 'InternalNote' OR "muted_notification_types" ? 'MentionedInNote');
