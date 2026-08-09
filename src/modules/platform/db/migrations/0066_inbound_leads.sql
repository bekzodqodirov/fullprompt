-- Leads that arrive by themselves: an advert, a public form, the bot.
--
-- Everything here is ADDITIVE. The system is live and the funnel is the sales
-- team's daily screen, so nothing that already exists changes shape.

-- The ledger of arrivals. It exists for two jobs the leads table cannot do:
-- an IDEMPOTENCY key (Meta re-delivers a webhook until it gets a 200, and a
-- reload re-posts a form), and an honest record of what was DROPPED — the
-- capped, the duplicated, the ones that matched a client. A lead row cannot
-- record a lead that was deliberately not created.
CREATE TABLE lead_intakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('form', 'meta', 'telegram')),
  -- Meta's leadgen_id, or null for a form post. UNIQUE per channel, so the
  -- second delivery of the same advert lead is refused by the database rather
  -- than by a check somebody can forget.
  external_id text,
  source_key text,
  ref jsonb,
  phone text,
  name text,
  outcome text NOT NULL CHECK (outcome IN ('created', 'joined', 'client', 'dropped')),
  -- Why it was dropped, when it was: 'duplicate' / 'capped' / 'no_contact'.
  reason text,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX lead_intakes_external_idx
  ON lead_intakes (channel, external_id)
  WHERE external_id IS NOT NULL;

-- The two questions the caps ask, both windowed on time.
CREATE INDEX lead_intakes_phone_idx ON lead_intakes (phone, created_at)
  WHERE phone IS NOT NULL;
CREATE INDEX lead_intakes_source_idx ON lead_intakes (source_key, created_at);

-- A STABLE name for a source, so the code can say «instagram» while the owner
-- renames the row to whatever he likes. Find-or-create by NAME would split
-- `funnelReport` in two the first time somebody edits «Instagram» to
-- «Instagram (reklama)».
ALTER TABLE lead_sources ADD COLUMN key text;
CREATE UNIQUE INDEX lead_sources_key_idx ON lead_sources (key) WHERE key IS NOT NULL;

-- Who is in the rotation for leads that arrive by themselves. A COLUMN on the
-- role, following `warehouse_scoped` (round 23): the funnel's «who may be
-- shown in a dropdown» is a different question, and it deliberately re-adds
-- deactivated people so a picker can render the current holder.
ALTER TABLE roles ADD COLUMN inbound_rota boolean NOT NULL DEFAULT false;

-- A lead nobody created. `created_by` has been NOT NULL since phase 2.3
-- because every lead came from a person pressing a button; an advert has no
-- person, and naming the round-robin owner as its author would put a sentence
-- in the audit trail that nobody said. Relaxing a NOT NULL is safe on a live
-- table (0056's precedent) and no existing row changes.
ALTER TABLE leads ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE crm_activities ALTER COLUMN created_by DROP NOT NULL;

-- Marks a lead that arrived by itself, and from where. `source_id` keeps its
-- meaning (the owner's editable dictionary); this is the machine's own record,
-- and it is what the rotation counts.
ALTER TABLE leads ADD COLUMN inbound_at timestamptz;
CREATE INDEX leads_inbound_idx ON leads (owner_id, inbound_at) WHERE inbound_at IS NOT NULL;
