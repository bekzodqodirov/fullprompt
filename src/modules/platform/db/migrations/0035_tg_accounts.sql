-- The stored Telegram login behind live receiving (phase 3 of the client chat).
--
-- Purely ADDITIVE, like 0034: one new table, nothing existing is touched.
--
-- This is the first reversible secret the system keeps. Passwords, browser
-- sessions and driver pairing tokens are all one-way hashes, because nothing
-- ever needs them back; a Telegram session string has to be handed to the
-- library on every reconnect, so it is stored ENCRYPTED (AES-256-GCM, key in
-- the server .env as TG_SESSION_KEY, bound to the owning user id so a row
-- lifted between managers will not open).
--
-- One row per manager, and the row is the whole record: there is exactly one
-- current session per account, and replacing it IS the operation.
CREATE TABLE IF NOT EXISTS tg_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One account per manager. A second login for the same person REPLACES the
  -- first, because two live connections on one Telegram account is exactly
  -- what gets a personal account flagged.
  manager_user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  -- The Telegram phone this session belongs to; may differ from the login
  -- phone in this system, and is shown on the status screen so a manager can
  -- see WHICH of their numbers is connected.
  tg_phone text NOT NULL,
  -- v1.<iv>.<tag>.<ciphertext>, base64. Never a session string in the clear.
  session_enc text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  -- Heartbeat from the listener, so the screen can say "connected 20 s ago"
  -- rather than assuming a row means a live connection. A bridge that died
  -- quietly is the failure mode worth showing.
  last_seen_at timestamptz,
  -- Why it stopped, when it stopped: a session Telegram itself ended needs a
  -- new login, a key that no longer opens needs the .env fixed, and both look
  -- identical from the outside.
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tg_accounts DROP CONSTRAINT IF EXISTS tg_accounts_status_check;
ALTER TABLE tg_accounts ADD CONSTRAINT tg_accounts_status_check
  CHECK (status IN ('active', 'stopped', 'signed_out'));
