-- Photo replies (feedback item 15, the sending half). A queued message may
-- now carry ONE photo; the body becomes the caption and may then be empty —
-- a photo with no caption is a real message, the same principle the import
-- applies to incoming media.

ALTER TABLE tg_outbox ADD COLUMN IF NOT EXISTS attachment_id uuid REFERENCES attachments(id);

-- Relaxed, not dropped: a row with neither text nor a photo is still not a
-- message, and a blank send would still cost a rate-limit slot on a personal
-- account.
ALTER TABLE tg_outbox DROP CONSTRAINT IF EXISTS tg_outbox_body_check;
ALTER TABLE tg_outbox ADD CONSTRAINT tg_outbox_body_check
  CHECK (length(btrim(body)) > 0 OR attachment_id IS NOT NULL);
