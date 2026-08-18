-- The staff-notification drain gets a CLAIM (the audit's finding, stated to
-- the owner and now closed).
--
-- `sendPendingTelegram` used to SELECT status='pending' and only flip a row
-- AFTER the Telegram round trip — so any two drains running at once read the
-- same thirty rows and both delivered them. Two drains is not hypothetical:
-- a partially-failed boot used to register the worker twice, and the
-- tg-listen container used to boot the whole worker fleet (both also fixed
-- this round). The claim makes the race harmless whatever else regresses:
-- a row is taken by ONE drain, atomically, before anything leaves.
--
-- `claimed_at` is what makes a crashed drain recoverable: a row stuck in
-- 'sending' past ten minutes is put back (or failed, if it is out of
-- attempts) by the next drain. Without the timestamp a crash mid-batch
-- would park its thirty rows in 'sending' for ever.

ALTER TABLE notifications ADD COLUMN claimed_at timestamptz;

ALTER TABLE notifications DROP CONSTRAINT notifications_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'muted'));
