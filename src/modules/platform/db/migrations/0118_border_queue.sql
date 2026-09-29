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
-- TWO clocks, and they must not be one:
-- `updated_at` is the last write of any kind — the panel's «⚠ N kun oldin»
-- and the colleague check (`seenAt`) read it, and a note edit or a
-- re-confirmed number moves it. `hours_since` is when the HOURS last changed,
-- and the ETA counts a truck already queueing from that moment
-- (tracking/eta.ts `routeWithWaits`). Were they one column, typing a note
-- would restart every queued truck's wait and add the time it had already
-- stood to its customer's date.
--
-- `prev_*` is the regime in force BEFORE `hours_since`: the hours that were
-- typed then (NULL = his default) and since when. Whether a truck had already
-- crossed when the number changed is judged against the wait it was actually
-- being given, not against the defaults — raising a long queue must never move
-- a truck that has queued past the default midpoint across the border. One
-- level of history is enough: a truck older than it is judged by the default.
-- All of it is written by the service only, never by a trigger.
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
  "hours_since" timestamptz NOT NULL DEFAULT now(),
  "prev_min_hours" integer,
  "prev_max_hours" integer,
  "prev_since" timestamptz,
  CONSTRAINT "border_queue_post_unique" UNIQUE ("post"),
  CONSTRAINT "border_queue_pair_check" CHECK (("min_hours" IS NULL) = ("max_hours" IS NULL)),
  CONSTRAINT "border_queue_range_check" CHECK ("min_hours" IS NULL OR ("min_hours" >= 0 AND "max_hours" >= "min_hours" AND "max_hours" <= 720)),
  CONSTRAINT "border_queue_prev_pair_check" CHECK (("prev_min_hours" IS NULL) = ("prev_max_hours" IS NULL)),
  CONSTRAINT "border_queue_prev_range_check" CHECK ("prev_min_hours" IS NULL OR ("prev_min_hours" >= 0 AND "prev_max_hours" >= "prev_min_hours" AND "prev_max_hours" <= 720 AND "prev_since" IS NOT NULL)),
  CONSTRAINT "border_queue_note_len" CHECK ("note" IS NULL OR length("note") <= 300)
);
