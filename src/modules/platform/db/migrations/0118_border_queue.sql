-- «Chegara navbatlari» (owner, 2026-09-29, answer 14: «sho yol ocheredda
-- kutishlani qolda kirgazish imkoni bolsa yahwi bolar edi ochered kamaysa tez
-- otb ketadiku»): the queue a truck waits in at a border post, typed by the
-- logist, one row per post. Horgos (China → Kazakhstan) and Yallama
-- (Kazakhstan → Uzbekistan) today; the list of posts lives in the code
-- (`BORDER_POSTS`, tracking/map-data.ts) and is the only gate, so there is no
-- CHECK on `post` — a post added to the code needs no migration.
--
-- No rows are inserted. An ABSENT row, or a row whose hours are NULL, means
-- «his default» (the corridor's own numbers in map-data.ts), which is what
-- every installation honestly has on deploy day. «Odatdagi jadvalga
-- qaytarish» NULLs the hours and keeps the row, so the id the audit history
-- names survives the reset.
--
-- `updated_at` is when the number was typed, and it is part of the rule, not
-- decoration: the ETA counts a truck already queueing from that moment
-- (tracking/eta.ts `routeWithWaits`), so it is written by the service and
-- never by a trigger that a later UPDATE of the note would move.
--
-- 720 hours is the service's 30-day cap restated as a last guard: a typed
-- «300» meant as hours reaches every customer's date at once.
CREATE TABLE "border_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "post" text NOT NULL,
  "min_hours" integer,
  "max_hours" integer,
  "note" text,
  "updated_by" uuid REFERENCES "users"("id"),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "border_queue_post_unique" UNIQUE ("post"),
  CONSTRAINT "border_queue_pair_check" CHECK (("min_hours" IS NULL) = ("max_hours" IS NULL)),
  CONSTRAINT "border_queue_range_check" CHECK ("min_hours" IS NULL OR ("min_hours" >= 0 AND "max_hours" >= "min_hours" AND "max_hours" <= 720)),
  CONSTRAINT "border_queue_note_len" CHECK ("note" IS NULL OR length("note") <= 300)
);
