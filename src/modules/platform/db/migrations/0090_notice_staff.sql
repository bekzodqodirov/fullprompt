-- One arrival message per truck for the STAFF too (owner, 2026-08-25:
-- «10 ta karobka kelsa 10 ta sms, 1 dona "10 ta keldi" emas»).
--
-- Round 98 fixed the CLIENT's copy with this very table: the first landed box
-- claims the right to speak, the totals are read minutes later, one message
-- per customer per truck. The STAFF copy was deliberately left riding the
-- per-scan `ReadyForPickup` event — which is exactly what he is now reporting:
-- his seller gets one Telegram per carton.
--
-- The event moves onto the same claim, and needs two columns to do it
-- honestly:
--
--   staff_notified_at — the once-fence for the EVENT, separate from `status`
--     because the two answer different questions. `status` is about reaching
--     the customer's Telegram (and a client with no linked chat settles
--     `skipped`), while the event feeds the seller's notification, the deal's
--     cargo trigger and the automation rules — none of which need Telegram at
--     all. Hanging one on the other would lose the seller's message for every
--     customer who has never opened the bot, and for every hour the bot token
--     is being rotated.
--
--   claimed_by — WHO was scanning when the truck landed. The event used to be
--     emitted inside the scan's transaction and carried that person as its
--     actor; emitted from a worker it would carry nobody, and an automation
--     rule whose assignee strategy is «whoever did it» would quietly stop
--     firing with its own fire_count not even moving.
--
-- Both are nullable and additive: every row already in the table reads
-- «nobody has been told yet», which for a truck that landed before this
-- deploy is exactly right — its cartons emitted their own events at the time.
ALTER TABLE "client_notices" ADD COLUMN IF NOT EXISTS "staff_notified_at" timestamptz;
ALTER TABLE "client_notices" ADD COLUMN IF NOT EXISTS "claimed_by" uuid REFERENCES "users"("id");

-- The staff sweep's own selector: rows nobody has been told about, whatever
-- their Telegram outcome. Partial, so it stays a small index over a table
-- that only ever grows.
CREATE INDEX IF NOT EXISTS "client_notices_staff_due"
  ON "client_notices" ("send_after")
  WHERE "staff_notified_at" IS NULL;

-- Backfill: every notice that already exists was created by the old path,
-- which emitted the staff event per scan. Stamping them keeps the new sweep
-- from re-announcing yesterday's trucks on the morning of the deploy.
UPDATE "client_notices" SET "staff_notified_at" = COALESCE("sent_at", "created_at")
  WHERE "staff_notified_at" IS NULL;

-- The CLIENT send needs a claim too — 0082's shape, which this drain never
-- got. pg-boss re-dispatches a slow job while the first run is still going,
-- and a plain `SELECT … status='pending'` hands both runs the same rows: the
-- customer is told twice, which is the exact noise this table was built to
-- stop. `sending` is claimed with FOR UPDATE SKIP LOCKED and reclaimed ten
-- minutes later if the drain that took it died.
ALTER TABLE "client_notices" ADD COLUMN IF NOT EXISTS "claimed_at" timestamptz;
ALTER TABLE "client_notices" DROP CONSTRAINT IF EXISTS "client_notices_status_check";
ALTER TABLE "client_notices" ADD CONSTRAINT "client_notices_status_check"
  CHECK ("status" IN ('pending', 'sending', 'sent', 'failed', 'skipped'));
