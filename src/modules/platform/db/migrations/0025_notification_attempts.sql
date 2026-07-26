-- A Telegram send that can never succeed must not retry for ever.
--
-- `sendPendingTelegram` rethrew on the first failure so pg-boss would retry —
-- but that aborted the whole batch, so one driver who blocked the bot stopped
-- every other message in the queue, including "boxes missing in transit".
-- With an attempts counter a doomed row reaches `failed` and steps aside.
ALTER TABLE notifications ADD COLUMN attempts integer NOT NULL DEFAULT 0;
