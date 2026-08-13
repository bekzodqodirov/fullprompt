-- One message per customer per truck, and it survives a restart (round 98).
--
-- The owner: «mashinadan yuk tushganda yukingiz keldi deb har bir karobka
-- uchun habar jonatyabti». He is exactly right, and the reason is in
-- `ingestUnloadScans`: the phone's scan queue is walked one input per
-- TRANSACTION, and the client's «yetib keldi» was emitted inside that
-- transaction. One carton scanned = one event = one Telegram message. The
-- «accept everything remaining» button is worse still — it feeds one input
-- per short code through the same door, so one press on a 200-box truck is
-- up to 200 messages.
--
-- The fix cannot be «send it when the unload is finished»: that button is not
-- always pressed, and hanging a customer's message on a human habit is how it
-- goes silent. So the first box that lands CLAIMS the notice, and a worker
-- sends it a few minutes later — by which time the rest of the truck has been
-- scanned and the totals it prints are the real ones.
--
-- The claim is a ROW, not a flag in memory: an app restart between the claim
-- and the send would otherwise lose the message entirely, which is worse than
-- the noise this replaces. `status` carries it through the same
-- pending→sent/failed shape the staff notifications already use.
--
-- The UNIQUE index is the whole guarantee. It is claimed with
-- `ON CONFLICT DO NOTHING` inside the movement's own transaction (round 83's
-- claim-before-work rule), so two scanners unloading the same truck at the
-- same second cannot both win it.
CREATE TABLE IF NOT EXISTS client_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  -- What happened. Free text rather than an enum: the next kind is a
  -- one-line change and this table is written from one module.
  kind text NOT NULL,
  -- What it happened TO — a batch for an arrival, so the same truck can
  -- never notify the same customer twice.
  ref_type text NOT NULL,
  ref_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  -- Not before this. The window that collapses a truck's scans into one
  -- message; `finishUnload` pulls it forward to now.
  send_after timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_notices_status_check
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS client_notices_once
  ON client_notices (client_id, kind, ref_type, ref_id);
--> statement-breakpoint
-- The worker's own question: what is due?
CREATE INDEX IF NOT EXISTS client_notices_due
  ON client_notices (send_after)
  WHERE status = 'pending';
