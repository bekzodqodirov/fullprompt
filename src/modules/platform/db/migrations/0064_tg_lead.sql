-- The owner's Telegram ↔ CRM loop (2026-08-08), his design, in three parts.
--
-- 1. A CONNECTED ACCOUNT IS PERSONAL UNTIL SOMEBODY SAYS OTHERWISE.
-- He confirmed the accounts connected today are personal numbers and that
-- work numbers will exist too («shaxsiy raqam ham bor ish raqam ham bor»),
-- and asked for the choice to be each person's own. Default false, because
-- the safe answer must be the one nobody has to pick: on a personal account
-- an unknown chat is a QUESTION, on a work account it is a lead.
ALTER TABLE tg_accounts ADD COLUMN work_account boolean NOT NULL DEFAULT false;

-- 2. A CONVERSATION MAY BELONG TO AN OPEN LEAD.
-- Until now `client_id NOT NULL` was the privacy fence: a chat was kept only
-- if the peer's phone was already in the client book, so a NEW customer
-- writing in produced nothing at all — the owner's report («telegramdan
-- yangi klientlar … nega korinmayabti»). The door widens to «client book OR
-- an open lead», which is exactly what 0063 did for call recordings a week
-- ago, down to the CHECK: every stored message still names its owner, so a
-- chat belonging to neither is structurally impossible rather than merely
-- unwritten.
ALTER TABLE tg_messages ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE tg_messages ADD COLUMN lead_id uuid REFERENCES leads(id);
ALTER TABLE tg_messages ADD CONSTRAINT tg_messages_owner_check
  CHECK (client_id IS NOT NULL OR lead_id IS NOT NULL);
CREATE INDEX tg_messages_lead_idx ON tg_messages (lead_id, sent_at DESC)
  WHERE lead_id IS NOT NULL;

-- 3. THE LOOKBACK INDEX — A HASH, AND DELIBERATELY NOTHING ELSE.
-- He asked that creating a lead, a deal or a client check the connected
-- accounts for that number and offer the existing chat. Answering that needs
-- a list of every chat each account has, which — stored in the obvious way —
-- is a copy of an employee's private address book sitting in the company
-- database. It is stored as sha256 of the NORMALISED LAST NINE DIGITS with a
-- pepper instead, and no name, so the only question this table can answer is
-- the only one we need to ask: «is this number one of them?». There is no
-- query that turns it back into a list of people.
--
-- The pepper is derived from SESSION_SECRET; rotating that secret makes every
-- row unmatchable, which is safe rather than broken — the nightly refresh
-- rebuilds the index from the accounts themselves.
CREATE TABLE tg_peer_index (
  id uuid PRIMARY KEY,
  manager_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_id bigint NOT NULL,
  phone_hash text NOT NULL,
  last_message_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tg_peer_index_peer_uniq UNIQUE (manager_user_id, peer_id)
);
CREATE INDEX tg_peer_index_hash_idx ON tg_peer_index (phone_hash);
