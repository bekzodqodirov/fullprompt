-- Which chats go into the CRM, decided by a person rather than only by a rule.
--
-- Owner: "shunda feature qo'sh — qaysi chatlarni qo'shish kerak va qaysini
-- qo'shmaslik." Until now the answer was entirely automatic: a conversation was
-- kept when the peer's phone number matched the client book. That rule is
-- right, and it is not enough:
--
--   * Telegram shows a phone number only to CONTACTS, so a real client the
--     manager never saved is invisible to it (122 of these in the first run);
--   * a client who writes from a second number is a stranger to it;
--   * and a chat it DOES match may still be one nobody wants in the CRM.
--
-- So a rule can now be written down, and an explicit rule beats the automatic
-- one in both directions.
--
-- Purely ADDITIVE: one new table.
--
-- What this table holds about a chat is the narrowest thing that can be
-- decided from: the peer's Telegram id, their display name, and their number
-- if Telegram shows it. NO message ever lands here — a chat nobody has said
-- "yes" to must not leave a trace of what was said in it, and `tg_messages`
-- is still the only place a message can go.
CREATE TABLE IF NOT EXISTS tg_chat_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Whose account this chat is in. Rules are per manager: the same Telegram
  -- user may be a client in one manager's phone and a friend in another's,
  -- and neither of them gets to answer for the other.
  manager_user_id uuid NOT NULL REFERENCES users(id),
  peer_id bigint NOT NULL,
  -- pending: seen by a scan the MANAGER ran, waiting for their answer.
  -- include: store this chat, as the client named below.
  -- exclude: never store it, and never ask again.
  decision text NOT NULL DEFAULT 'pending',
  client_id uuid REFERENCES clients(id),
  -- What to show on the screen so the decision can be made at all. A snapshot,
  -- not a mirror: it is refreshed by a scan and never kept in step otherwise.
  peer_title text,
  peer_phone text,
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tg_chat_rules DROP CONSTRAINT IF EXISTS tg_chat_rules_decision_check;
ALTER TABLE tg_chat_rules ADD CONSTRAINT tg_chat_rules_decision_check
  CHECK (decision IN ('pending', 'include', 'exclude'));

-- An included chat MUST name a client, because `tg_messages.client_id` is NOT
-- NULL and there would otherwise be nowhere to put its messages. Enforced here
-- rather than in the action, so no future caller can create a rule that
-- promises a message a home it does not have.
ALTER TABLE tg_chat_rules DROP CONSTRAINT IF EXISTS tg_chat_rules_include_check;
ALTER TABLE tg_chat_rules ADD CONSTRAINT tg_chat_rules_include_check
  CHECK (decision <> 'include' OR client_id IS NOT NULL);

-- One answer per chat per manager. A re-scan updates the snapshot; it must not
-- add a second row and quietly leave two answers to the same question.
CREATE UNIQUE INDEX IF NOT EXISTS tg_chat_rules_unique_idx
  ON tg_chat_rules (manager_user_id, peer_id);

-- The screen reads "what is still waiting", per manager.
CREATE INDEX IF NOT EXISTS tg_chat_rules_pending_idx
  ON tg_chat_rules (manager_user_id, decision);
