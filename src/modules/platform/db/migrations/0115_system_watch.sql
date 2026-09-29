-- «Tizim o'zini kuzatadi» (owner approved B9, 2026-09-28). The system watches
-- its own moving parts — the bot, the Telegram bridge, the disk, the errors a
-- staff member photographs — and says so on the screens the owner already
-- reads. Additive only: two new tables and two new columns with safe defaults,
-- so no existing row changes meaning and nothing is rewritten.

-- One row per thing that is currently WRONG (or, for the disk, how wrong).
-- A row is a state, not a log: it exists while the fault stands and is
-- deleted when it clears. `since` is written once, when the fault began, and
-- a later write only moves `detail` / `updated_at` — «14:02 dan beri» must
-- not creep forward every time the fault is seen again. `level` is the disk's
-- alarm step (0 / 80 / 90); everything else leaves it at 0.
-- platform/diagnostics/signals.ts is the only writer.
CREATE TABLE "system_signals" (
  "key" text PRIMARY KEY,
  "since" timestamptz NOT NULL DEFAULT now(),
  "level" integer NOT NULL DEFAULT 0,
  "detail" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- The server's own errors, so a digest in a staff member's screenshot
-- («#2832070603») can be typed into a page and answered. ONE row per error
-- (the digest, or a hash of route + message where Next gives none), counted,
-- never a row per occurrence — an error in a loop must not fill the disk
-- that is also the database's. `user_id` is SET NULL on delete: a record of
-- a fault must never be the reason a user cannot be removed (23503).
CREATE TABLE "system_errors" (
  "key" text PRIMARY KEY,
  "digest" text,
  "kind" text NOT NULL CHECK ("kind" IN ('render', 'action', 'route', 'other')),
  "path" text,
  "message" text NOT NULL,
  "stack" text,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "count" integer NOT NULL DEFAULT 1,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "system_errors_last_seen_idx" ON "system_errors" ("last_seen_at" DESC);

-- The quiet-bridge alarm (wms/crm/listener-quiet.ts). `quiet_open` = «jim»
-- was said and «qaytdi» has not been; `quiet_notified_at` = when «jim» was
-- last said, KEPT after the bridge returns, because it is the clock that
-- stops a listener that beats once and dies from ringing every quarter hour.
ALTER TABLE "tg_accounts" ADD COLUMN "quiet_notified_at" timestamptz;
ALTER TABLE "tg_accounts" ADD COLUMN "quiet_open" boolean NOT NULL DEFAULT false;
