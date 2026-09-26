-- The owner's item 6 (2026-09-26): «habar yoza olay juma bn tabriklab … mijoz
-- kodini yasayotganda ularni tugilgan kuni kirgazilsin … sohasini va nima yuk
-- urishini belgilab ketish imkoni bolsin shunda … malum sohadigilarga
-- offerlar … berish imkoni boladi».
--
-- The client's contact person's birthday («kantakt odamning tugilgan kuni
-- kirgazilsa yetarli»), the trade the client is in, and the kinds of cargo
-- they bring — free words a person types, offered back as suggestions so they
-- converge; the broadcast filters on them. `birthday_alerted_on` makes the
-- birthday reminder fire once a day, whatever restarts.
ALTER TABLE "clients"
  ADD COLUMN "birthday" date,
  ADD COLUMN "sector" text,
  ADD COLUMN "cargo_kinds" text[] NOT NULL DEFAULT '{}',
  ADD COLUMN "birthday_alerted_on" date;

-- One message the office sent to its clients through the bot: the words, who
-- it was meant for (the filters as chosen, kept for the record), and the
-- running count the screen reads while the job sends.
CREATE TABLE "broadcasts" (
  "id" uuid PRIMARY KEY,
  "body" text NOT NULL DEFAULT '',
  "audience" jsonb NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "finished_at" timestamp with time zone,
  "total" integer NOT NULL DEFAULT 0,
  "sent" integer NOT NULL DEFAULT 0,
  "failed" integer NOT NULL DEFAULT 0,
  CONSTRAINT "broadcasts_body_check" CHECK (length("body") <= 4096)
);

-- One row per CHAT, not per client: a person holding three codes on one phone
-- gets the message once (round 10, #267).
CREATE TABLE "broadcast_recipients" (
  "broadcast_id" uuid NOT NULL REFERENCES "broadcasts"("id") ON DELETE CASCADE,
  "chat_id" bigint NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "clients"("id"),
  "status" text NOT NULL DEFAULT 'pending',
  "error" text,
  "claimed_at" timestamp with time zone,
  "sent_at" timestamp with time zone,
  PRIMARY KEY ("broadcast_id", "chat_id"),
  CONSTRAINT "broadcast_recipients_status_check" CHECK ("status" IN ('pending', 'sending', 'sent', 'failed'))
);
CREATE INDEX "broadcast_recipients_pending_idx" ON "broadcast_recipients" ("broadcast_id") WHERE "status" = 'pending';
