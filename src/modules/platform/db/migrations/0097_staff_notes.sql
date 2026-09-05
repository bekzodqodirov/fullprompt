-- Zametkalar — the staff bot's note library: the things the office sends the
-- same customers over and over, kept once and re-sent with one tap.
--
-- The owner, 2026-09-05: «telegram botga zametkalarni qoyamiz u yerdan har
-- doim ishlatadgan rasim file text locationlarni tanlaganda bot qayta jonatb
-- berishi kerak misol uchun skladlarimizni adreslarini kirgazb qoyamiz ushani
-- soraganda berishi kerak». His five answers are FIXED: the admin writes the
-- COMPANY's notes and every staff member also keeps their own (1b); they are
-- written both on a screen and in the bot (2c); the bot sends into the ASKING
-- staff member's own chat and never straight to a customer (3a); one note
-- carries several parts — his warehouse info is already an image — and one
-- tap sends them all (4); a flat list is enough, no categories (5).
--
-- Two tables, and the second is not ceremony. The parts are ordinary
-- `attachments` rows, which is what makes them backed up, thumbnailed and
-- deletable by the machinery that already exists — but that table is
-- polymorphic and carries no order and nothing Telegram-shaped, so the facts
-- that belong to a note's use of a file live beside it: WHERE the part sits in
-- the note, HOW it must be sent, and the id Telegram gave us for those exact
-- bytes last time.

-- 1. The note itself.
CREATE TABLE "staff_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- NULL = the COMPANY's, written by whoever may publish and offered to
  -- everybody. Otherwise it is that person's and nobody else sees it.
  -- `list_views` and `reply_templates` carry this exact column for the same
  -- reason, and the read is the same one-liner: user_id IS NULL OR user_id = me.
  "user_id" uuid REFERENCES "users"("id") ON DELETE cascade,
  -- What the button says. Trimmed and bounded by the service: an inline
  -- button's text may not be empty, and a company note is in EVERY staff
  -- member's list — one row of spaces would break the 📌 list for the whole
  -- company at once, not for its author.
  "title" text NOT NULL,
  -- Optional, deliberately: his own example is an image plus a pin, and a
  -- note that is only a photograph is a legitimate note. «A note must carry
  -- something» is a rule about the note AND its parts, so it lives in the
  -- service — no CHECK can span two tables.
  "body" text,
  "lat" numeric(9, 6),
  "lon" numeric(9, 6),
  "place_title" text,
  "place_address" text,
  "sort_order" integer DEFAULT 100 NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Half a coordinate is not a place.
  CONSTRAINT "staff_notes_geo_check" CHECK (("lat" IS NULL) = ("lon" IS NULL)),
  -- Telegram's sendVenue takes title AND address, both required — a venue
  -- with one of them is a refusal at SEND time, and the pin is sent LAST, so
  -- it would fail after every other part had already arrived in the chat.
  -- The pair CHECK is 0083's shape, and it is the reason this one exists.
  CONSTRAINT "staff_notes_place_pair_check" CHECK (("place_title" IS NULL) = ("place_address" IS NULL)),
  -- A place name without a point is a name for nothing.
  CONSTRAINT "staff_notes_place_geo_check" CHECK ("lat" IS NOT NULL OR "place_title" IS NULL)
);
--> statement-breakpoint
CREATE INDEX "staff_notes_owner_idx" ON "staff_notes" ("user_id", "sort_order");
--> statement-breakpoint
-- A library picked from BY EYE: two rows with one name is a trap. Scoped, not
-- global — an admin publishing «Xitoy sklad» must not break the row a seller
-- wrote for themselves, so the two scopes are policed separately and the bot
-- marks the company's with 🏢 where they meet.
CREATE UNIQUE INDEX "staff_notes_own_title_uniq"
  ON "staff_notes" ("user_id", lower(btrim("title"))) WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "staff_notes_company_title_uniq"
  ON "staff_notes" (lower(btrim("title"))) WHERE "user_id" IS NULL;
--> statement-breakpoint
-- 2. A part: one attachment, used by one note.
CREATE TABLE "staff_note_parts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "note_id" uuid NOT NULL REFERENCES "staff_notes"("id") ON DELETE cascade,
  -- The bytes stay ordinary attachments, so the off-site object copy, the
  -- thumbnails and the delete path all reach them with no new machinery.
  "attachment_id" uuid NOT NULL REFERENCES "attachments"("id") ON DELETE cascade,
  -- The order the parts are SENT in. `attachments` has no sort column and is
  -- shared by nine other entity types, so the order a note wants lives here —
  -- otherwise «one tap sends every part, in the right order» rests on the
  -- accident that the uploads happened to be serial.
  "sort_order" integer DEFAULT 100 NOT NULL,
  -- WHICH Telegram method must carry this file. Not derived at send time from
  -- the byte size, because sendPhoto refuses on three separate rules — bytes,
  -- width+height summed, and the ratio — and `attachments` stores no
  -- dimensions, so a tall address sheet passes the byte test and fails the
  -- others. Decided by the admin (a photograph shows in the chat; a document
  -- keeps every pixel) and PERSISTED when Telegram itself refuses the photo
  -- shape, so the next tap stops proposing a shape already refused once.
  "send_as" text DEFAULT 'photo' NOT NULL,
  -- Telegram's own id for these exact bytes. A cache with a verified
  -- fallback: it turns a multi-megabyte upload into a string on every send
  -- after the first, and any refusal naming the file clears it and the bytes
  -- go up again. It is typed BY THE METHOD that minted it, which is why
  -- `send_as` is stored beside it and the id is reused only when the two
  -- agree. NOTE for whoever does the outstanding bot-token rotation: /revoke
  -- issues a new token for the SAME bot account, and a file_id is scoped to
  -- the account — these survive it, and no cache-clearing deploy step is owed.
  "telegram_file_id" text,
  "telegram_sent_as" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "staff_note_parts_send_as_check" CHECK ("send_as" IN ('photo', 'document')),
  CONSTRAINT "staff_note_parts_sent_as_check"
    CHECK ("telegram_sent_as" IS NULL OR "telegram_sent_as" IN ('photo', 'document')),
  -- A cached id that cannot say which method made it is worse than no cache.
  CONSTRAINT "staff_note_parts_cache_pair_check"
    CHECK (("telegram_file_id" IS NULL) = ("telegram_sent_as" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "staff_note_parts_note_idx" ON "staff_note_parts" ("note_id", "sort_order");
--> statement-breakpoint
-- One attachment belongs to one note once. Re-claiming the same upload would
-- send the same photograph twice with nothing on screen to explain it.
CREATE UNIQUE INDEX "staff_note_parts_attachment_uniq" ON "staff_note_parts" ("attachment_id");
