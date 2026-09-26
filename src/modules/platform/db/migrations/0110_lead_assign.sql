-- Round 113: «saytdan kelgan zaproslar hodimlar sotuv managerlari orasida
-- taqsimlansin va hodimlarda belgilaylik qanday zaprosga kim javob beradi».
-- The website asks «who in this team is least busy?», we answer with that
-- manager's Telegram username, and the visitor writes to them carrying a
-- one-off tag (GSR-…) that lets the listener land the conversation as a lead.
--
-- Additive: nobody has a team on deploy morning, so every question answers
-- «nobody» and the website keeps using its own list until the owner ticks
-- people on /admin/taqsimot. Nothing existing changes meaning.

-- Which website streams a person answers. A PERSON, like `inbound_rota`
-- (0073): «hamma sotuvchi, lekin hamma lead bilan ishlamaydi».
ALTER TABLE users ADD COLUMN lead_teams text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD CONSTRAINT users_lead_teams_check
  CHECK (lead_teams <@ ARRAY['cargo', 'buying', 'general']::text[]);

-- The @handle TYPED on /admin/taqsimot, for somebody whose Telegram is not
-- connected (the owner: «telegrami ulangan bolmasa ham ularni usernamini
-- kirgazadgan joy bolsin»). Such a person still takes website visitors; the
-- system just cannot see the conversation, so no lead opens by itself. A
-- connected account's own handle (below) always wins over this one.
-- Telegram's own rule: 5-32 characters, a letter first, letters/digits/_.
ALTER TABLE users ADD COLUMN telegram_username text;
ALTER TABLE users ADD CONSTRAINT users_telegram_username_check
  CHECK (telegram_username IS NULL OR telegram_username ~ '^[A-Za-z][A-Za-z0-9_]{3,31}$');

-- The @handle of the CONNECTED account, written by the listener from getMe()
-- — verified, where a typed one is only what somebody believed. It wins over
-- the typed one, and `checked_at` lets the website question stop trusting it
-- when nobody has confirmed it lately (a renamed handle can be taken by a
-- stranger, and a visitor must never be sent to one).
ALTER TABLE tg_accounts
  ADD COLUMN tg_username text,
  ADD COLUMN tg_username_checked_at timestamptz;

-- One row per question the website asked: who was offered, for which tag.
-- The OFFER, not the arrival — the arrival is a `lead_intakes` row written
-- when the visitor actually writes (channel 'site', external_id = tag), which
-- is what makes the tag single-use at the database level.
CREATE TABLE lead_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag text NOT NULL UNIQUE CHECK (tag ~ '^GSR-[A-Z0-9]{5,16}$'),
  team text NOT NULL CHECK (team IN ('cargo', 'buying', 'general')),
  topic text,
  page text,
  lang text,
  user_id uuid NOT NULL REFERENCES users(id),
  username text NOT NULL,
  -- Could the system see the conversation this offer starts? True only for a
  -- connected, live account. An offer nobody can confirm counts as work for
  -- the rest of the day; one that could have been confirmed and was not
  -- stops counting after 15 minutes (the visitor never wrote).
  capturable boolean NOT NULL DEFAULT false,
  -- No caller address is kept: the limiter lives in the app's memory, and a
  -- visitor's address stored beside the page they read is not worth holding.
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The CLAIM: who received the visitor, and which Telegram person the tag is
  -- now bound to. Re-entrant for that same pair (a listener that died half
  -- way finishes the landing on its next start) and closed to everybody
  -- else — a tag is single-use per PERSON, not per message.
  confirmed_at timestamptz,
  confirmed_user_id uuid REFERENCES users(id),
  peer_id bigint,
  lead_id uuid REFERENCES leads(id),
  client_id uuid REFERENCES clients(id),
  -- Why this person: the ranking as it stood at the moment of the pick (top
  -- candidates with their counts, plus who was left out and why), so «nega
  -- Aliga?» can be answered a day later from the record, not recomputed.
  ranking jsonb,
  CONSTRAINT lead_assignments_confirm_check CHECK (
    confirmed_at IS NOT NULL
    OR (confirmed_user_id IS NULL AND peer_id IS NULL AND lead_id IS NULL AND client_id IS NULL)
  )
);
CREATE INDEX lead_assignments_user_idx ON lead_assignments (user_id, created_at DESC);
CREATE INDEX lead_assignments_confirmed_idx
  ON lead_assignments (confirmed_user_id, confirmed_at DESC)
  WHERE confirmed_at IS NOT NULL;

-- The panel's «so'nggi so'rovlar» list reads newest first across everybody.
CREATE INDEX lead_assignments_created_idx ON lead_assignments (created_at DESC);
-- «Was this inbound lead already counted as an offer?» — asked by the load
-- query for every lead that arrived today, and the FK needs it for a delete.
CREATE INDEX lead_assignments_lead_idx ON lead_assignments (lead_id) WHERE lead_id IS NOT NULL;

-- The arrival's own channel. Not 'telegram' (the bot's advert door, whose
-- external ids are Telegram's) and not 'form' (typed on our page): a website
-- visitor who wrote to a manager carrying a tag is its own road, and the
-- arrivals ledger is where «is the website producing anything» is answered.
ALTER TABLE lead_intakes DROP CONSTRAINT lead_intakes_channel_check;
ALTER TABLE lead_intakes ADD CONSTRAINT lead_intakes_channel_check
  CHECK (channel IN ('form', 'meta', 'telegram', 'webhook', 'site'));
