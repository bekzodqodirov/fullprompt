-- A running import must be able to say it is still alive — and a dead one
-- must stop claiming it is running.
--
-- Two files uploaded on 2026-09-04 sat at «читается» with 0 rows for hours.
-- The parse is a pg-boss job; a job that throws is retried and, once the
-- retries are spent, pg-boss forgets it — and NOTHING wrote that onto the
-- batch, because the worker only recorded a refusal it could name
-- («'Ед. из.' ustuni topilmadi»). A process killed mid-parse (out of memory,
-- a deploy, a full disk) never reaches the catch at all. Either way the row
-- said «processing» for ever, the screen offers no button on a processing
-- row, and the admin was left with two lines nothing in the system could move.
--
-- The heartbeat is what tells the two apart. The parse stamps it on a WALL
-- CLOCK — not every N rows, because a file smaller than one progress step
-- would show 0 rows the whole way and be indistinguishable from a dead one —
-- and the sweep fails a batch whose heartbeat has gone quiet.
--
-- Nullable and additive: batches uploaded before this deploy have no
-- heartbeat, and the sweep reads their upload time instead.
ALTER TABLE "customs_import_batches"
  ADD COLUMN "heartbeat_at" timestamptz;
--> statement-breakpoint
-- The sweep asks one question every five minutes: which batches are still
-- claiming to run? On a table holding a handful of rows a year this index is
-- politeness rather than need, but the question is asked on a clock for ever.
CREATE INDEX "customs_import_batches_processing_idx"
  ON "customs_import_batches" ("heartbeat_at")
  WHERE "status" = 'processing';
