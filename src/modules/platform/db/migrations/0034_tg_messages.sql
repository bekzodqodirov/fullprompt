-- The manager's Telegram conversation with a client, brought into the CRM
-- (owner: "biz clientlarimiz bn 95 foiz telegramda gaplashamiz shuni chatni
-- crmga o'tkaza olamizmi").
--
-- Purely ADDITIVE: one new table, nothing existing is touched. The owner's
-- production database holds the complete client base and this release must not
-- move a single row of it.
--
-- What is deliberately NOT stored: anything from a chat that does not belong
-- to a client. The importer only ever writes rows for a conversation whose
-- phone number matches the client book — a manager's family, friends and other
-- business never reach this table, and that is a promise the schema helps
-- keep, because there is no column here to put them in.
CREATE TABLE IF NOT EXISTS tg_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  -- Whose account this was read from. A client may talk to two managers and
  -- those are two conversations, not one thread with mixed voices.
  manager_user_id uuid NOT NULL REFERENCES users(id),
  -- Telegram's own identifiers. They are what makes a re-import free: running
  -- the import twice must add nothing, and the unique index below is what
  -- guarantees it rather than a "have I done this already" flag somebody
  -- forgets to set.
  peer_id bigint NOT NULL,
  tg_message_id bigint NOT NULL,
  direction text NOT NULL,
  body text,
  has_media boolean NOT NULL DEFAULT false,
  sent_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tg_messages DROP CONSTRAINT IF EXISTS tg_messages_direction_check;
ALTER TABLE tg_messages ADD CONSTRAINT tg_messages_direction_check
  CHECK (direction IN ('in', 'out'));

-- Re-running the import is a no-op, per manager. Not (peer, message) alone:
-- two managers may hold the same conversation and both are worth keeping.
CREATE UNIQUE INDEX IF NOT EXISTS tg_messages_unique_idx
  ON tg_messages (manager_user_id, peer_id, tg_message_id);

-- The client card reads it newest-last for one client.
CREATE INDEX IF NOT EXISTS tg_messages_client_idx ON tg_messages (client_id, sent_at);
