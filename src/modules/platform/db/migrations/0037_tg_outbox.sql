-- Replying to a client from the CRM — phase 4 of the client chat.
--
-- Purely ADDITIVE: one new table.
--
-- This is the phase that breaks the guarantee the first three were built on.
-- Phases 1-3 could say "there is no code path here that sends", and sending is
-- what gets a personal Telegram account limited or banned. From here on that
-- sentence is no longer true, so the protections have to live in the schema
-- and the code rather than in an absence.
--
-- A QUEUE rather than a direct send, for a reason that is structural: exactly
-- one process may hold a connection to a given account (the advisory lock in
-- telegram-accounts.ts), and that process is the listener. The web app must
-- never open a second one. So the web writes a row here and the listener —
-- which already holds the connection — picks it up, applies the rate limits,
-- and reports back.
--
-- The consequence the SCREEN must never hide: a queued row is not a delivered
-- message. If the listener is down, the row sits here and the client is still
-- waiting. That is the failure worth designing against, so `status` is
-- explicit and the thread shows a queued message differently from a sent one.
CREATE TABLE IF NOT EXISTS tg_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which conversation. `client_id` is NOT NULL for the same reason as in
  -- tg_messages: there is no such thing here as a message to nobody.
  client_id uuid NOT NULL REFERENCES clients(id),
  -- WHOSE account it goes out from. A message sent through this row appears to
  -- the client as coming from this person, so it is not a routing detail — it
  -- is whose name is on it.
  manager_user_id uuid NOT NULL REFERENCES users(id),
  peer_id bigint NOT NULL,
  body text NOT NULL,
  -- queued -> sending -> sent, or -> failed, or -> cancelled by a person who
  -- changed their mind before the listener got to it.
  --
  -- `sending` exists so that claiming a job is one atomic statement rather than
  -- a read followed by a write. A row left in it means the listener died with a
  -- message in flight, which is the one case nobody can resolve automatically:
  -- it may or may not have reached Telegram. Startup marks those FAILED and
  -- says so, rather than guessing and either double-sending or losing a reply.
  status text NOT NULL DEFAULT 'queued',
  -- Who pressed send. Not the same as manager_user_id in principle, and the
  -- code refuses when they differ — but the audit trail records both anyway.
  queued_by uuid NOT NULL REFERENCES users(id),
  queued_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  -- Telegram's id for the message once it exists, so the copy that echoes back
  -- through the listener can be reconciled with the row that asked for it.
  tg_message_id bigint,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);

ALTER TABLE tg_outbox DROP CONSTRAINT IF EXISTS tg_outbox_status_check;
ALTER TABLE tg_outbox ADD CONSTRAINT tg_outbox_status_check
  CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'cancelled'));

-- An empty message is not a message. Checked here as well as in the form,
-- because a blank send would still count against the account's rate limit.
ALTER TABLE tg_outbox DROP CONSTRAINT IF EXISTS tg_outbox_body_check;
ALTER TABLE tg_outbox ADD CONSTRAINT tg_outbox_body_check
  CHECK (length(btrim(body)) > 0);

-- The listener's only hot query: the oldest queued row for this account.
CREATE INDEX IF NOT EXISTS tg_outbox_queue_idx
  ON tg_outbox (manager_user_id, status, queued_at);

-- The thread screen, which must show a queued message in its place.
CREATE INDEX IF NOT EXISTS tg_outbox_client_idx
  ON tg_outbox (client_id, queued_at);
