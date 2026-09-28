-- «Reklama lidi sotuvchiga darhol yetib borsin» (owner, 2026-09-28, answer 5a:
-- the advert lead reaches its seller in Telegram at once, and if nobody
-- contacts it within 15 minutes the owner is reminded). The arrival already
-- has a row of its own — `lead_intakes` — and that row is where the clock
-- lives: it is per ARRIVAL (a joined re-enquiry has its own clock), and
-- `assigned_user_id` already records who it was handed to, so a later
-- reassignment cannot move a missed deadline onto somebody else.
--
-- Additive only: every column is nullable with no default, and NULL means
-- «not measured» — every arrival before this deploy, every `site`, `client`
-- and `dropped` arrival, and every joined one that landed inside a live
-- conversation. No backfill: a clock invented after the fact would measure
-- people against a rule they were never told about.

-- When the 15 minutes START: the arrival itself inside the office day, the
-- next opening outside it (wms/crm/first-contact.ts `contactClockFrom`). The
-- MEASUREMENT reads this — it does not depend on the reminder setting, so
-- switching the reminder off does not move anybody's numbers.
ALTER TABLE lead_intakes ADD COLUMN contact_clock_at timestamptz;

-- When the owner is to be reminded: the clock plus the setting's minutes of
-- OFFICE time, written once at landing. Stored rather than recomputed in SQL
-- because «15 office minutes after 21:55» is 09:10 the next morning, and that
-- arithmetic has one home (`contactDueAt`), in code a unit test can reach.
ALTER TABLE lead_intakes ADD COLUMN contact_due_at timestamptz;

-- The first contact the system could SEE, stamped by the minute sweep from
-- `firstContactSql` — the earliest evidence wins, because a call log uploads
-- late carrying its real `started_at`.
ALTER TABLE lead_intakes ADD COLUMN contacted_at timestamptz;
ALTER TABLE lead_intakes ADD COLUMN contact_kind text;
ALTER TABLE lead_intakes ADD CONSTRAINT lead_intakes_contact_kind_check
  CHECK (contact_kind IS NULL OR contact_kind IN ('call', 'telegram', 'note', 'stage', 'followup'));
-- Who made it. SET NULL like `assigned_user_id` — and deliberately OUTSIDE
-- the pair CHECK below: a CHECK spanning a column its own foreign key may
-- null out refuses the delete it was meant to survive (#809).
ALTER TABLE lead_intakes ADD COLUMN contacted_by uuid REFERENCES users(id) ON DELETE SET NULL;
-- A contact is a moment AND a kind, never one of them.
ALTER TABLE lead_intakes ADD CONSTRAINT lead_intakes_contact_pair_check
  CHECK ((contacted_at IS NULL) = (contact_kind IS NULL));

-- The one reminder per arrival: stamped by the claim BEFORE the message is
-- written, so two overlapping sweeps split the work (round 106's claim) and
-- a crash loses a reminder rather than sending it twice (round 83's trade).
ALTER TABLE lead_intakes ADD COLUMN contact_alerted_at timestamptz;

-- Both passes of the sweep range over the clocked arrivals of the last day or
-- week; the unclocked majority (dropped, client, every row before this) is
-- never read by them.
CREATE INDEX lead_intakes_contact_clock_idx ON lead_intakes (contact_clock_at)
  WHERE contact_clock_at IS NOT NULL;
