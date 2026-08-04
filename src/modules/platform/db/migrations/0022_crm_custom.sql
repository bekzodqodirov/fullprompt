-- CRM customisation (owner: "maximalna custom qilish imkoni bo'lsin,
-- amoCRM / Bitrix kabi").
--
-- Three things separate a configurable CRM from a fixed one: the funnel is
-- yours to reshape, the card carries the fields YOUR business asks about, and
-- one human being can hold several client codes.

-- A colour per stage, so a reshaped funnel still reads at a glance. Kept to a
-- fixed palette rather than free-form hex: the classes are compiled by
-- Tailwind, and an arbitrary colour would simply not render.
ALTER TABLE lead_stages ADD COLUMN color text NOT NULL DEFAULT 'gray';
--> statement-breakpoint
ALTER TABLE lead_stages ADD CONSTRAINT lead_stages_color_check
  CHECK (color IN ('gray', 'blue', 'green', 'amber', 'red', 'purple', 'teal'));
--> statement-breakpoint
-- Custom fields: the owner defines what a lead or a client card asks for,
-- without a deploy. `type` drives both the input widget and the validation.
CREATE TABLE crm_fields (
  id uuid PRIMARY KEY,
  entity_type text NOT NULL,
  label text NOT NULL,
  type text NOT NULL,
  /** Choices for select / multiselect; empty for every other type. */
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  required boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_fields_entity_check CHECK (entity_type IN ('lead', 'client')),
  CONSTRAINT crm_fields_type_check CHECK (type IN (
    'text', 'textarea', 'number', 'date', 'select', 'multiselect', 'checkbox', 'phone', 'url'
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX crm_fields_label_unique ON crm_fields (entity_type, lower(label));
--> statement-breakpoint
-- One row per (field, entity). Deleting a field takes its answers with it —
-- which is why the UI deactivates by default and only deletes on demand.
CREATE TABLE crm_field_values (
  field_id uuid NOT NULL REFERENCES crm_fields(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (field_id, entity_id),
  CONSTRAINT crm_field_values_entity_check CHECK (entity_type IN ('lead', 'client'))
);
--> statement-breakpoint
CREATE INDEX crm_field_values_entity_idx ON crm_field_values (entity_type, entity_id);
--> statement-breakpoint
-- One human being, several client codes (owner: "ha birlashtiraylik").
-- Deliberately a layer ABOVE clients rather than a merge: each code keeps its
-- own letters, stock, cargo history and cabinet link — merging the rows would
-- rewrite years of receipts — while the person ties them together for the
-- sales side.
CREATE TABLE crm_people (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  phones jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE clients ADD COLUMN person_id uuid REFERENCES crm_people(id);
--> statement-breakpoint
CREATE INDEX clients_person_idx ON clients (person_id);
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN person_id uuid REFERENCES crm_people(id);
--> statement-breakpoint
CREATE INDEX leads_person_idx ON leads (person_id);
