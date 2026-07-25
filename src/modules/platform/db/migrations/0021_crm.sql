-- Phase 2.3 CRM: the part of the sales job that happens BEFORE a client code
-- exists, plus the record of every conversation after it does.
--
-- Deliberately small. The client registry, the Telegram cabinet, the money
-- ledger and the per-client profit report already exist — CRM adds leads,
-- a contact history and the follow-up dates, and nothing else.

CREATE TABLE lead_sources (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  sort_order integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Funnel stages are DATA, not an enum: every company words its funnel
-- differently and the owner must be able to rename or add one without a
-- deploy. `kind` is the part the code reasons about — a stage is either
-- still open, a won deal or a lost one.
CREATE TABLE lead_stages (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  kind text NOT NULL DEFAULT 'open',
  sort_order integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_stages_kind_check CHECK (kind IN ('open', 'won', 'lost'))
);
--> statement-breakpoint
CREATE TABLE leads (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  phone text,
  company text,
  source_id uuid REFERENCES lead_sources(id),
  stage_id uuid NOT NULL REFERENCES lead_stages(id),
  /** The sales manager who owns the conversation. */
  owner_id uuid REFERENCES users(id),
  note text,
  /** "Call back on Friday" — the date the follow-up list is built from. */
  next_action_at date,
  next_action_note text,
  /** Set when the lead becomes a real client card; the lead row stays. */
  client_id uuid REFERENCES clients(id),
  lost_reason text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX leads_stage_idx ON leads (stage_id);
--> statement-breakpoint
CREATE INDEX leads_owner_idx ON leads (owner_id);
--> statement-breakpoint
CREATE INDEX leads_next_action_idx ON leads (next_action_at);
--> statement-breakpoint
CREATE UNIQUE INDEX leads_client_unique ON leads (client_id) WHERE client_id IS NOT NULL;
--> statement-breakpoint
-- One log for both sides of the funnel: the call that won a lead and the
-- call about a late payment a year later belong on the same timeline, and
-- keeping two tables would have split a single person's history in half.
CREATE TABLE crm_activities (
  id uuid PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  kind text NOT NULL,
  happened_at timestamptz NOT NULL DEFAULT now(),
  note text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_activities_entity_check CHECK (entity_type IN ('lead', 'client')),
  CONSTRAINT crm_activities_kind_check CHECK (kind IN ('call', 'meeting', 'message', 'note'))
);
--> statement-breakpoint
CREATE INDEX crm_activities_entity_idx ON crm_activities (entity_type, entity_id, happened_at DESC);
--> statement-breakpoint
-- Follow-ups on an existing client live on the client card, so a sales
-- manager has ONE list of "who am I calling today" covering both.
ALTER TABLE clients ADD COLUMN next_action_at date;
--> statement-breakpoint
ALTER TABLE clients ADD COLUMN next_action_note text;
--> statement-breakpoint
CREATE INDEX clients_next_action_idx ON clients (next_action_at);
