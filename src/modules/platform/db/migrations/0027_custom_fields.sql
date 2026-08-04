-- Custom fields everywhere (owner: "hech qanday biznes-obyekt hard-coded
-- bo'lmasin").
--
-- The engine already exists but only two objects may use it: crm_fields is
-- pinned to ('lead','client') by a CHECK, in five places that have to be
-- edited in lockstep. This migration moves it to the platform layer, replaces
-- the CHECK with a table the registry syncs, and gives answers TYPED columns
-- so a number filters as a number and a date sorts as a date.
--
-- Nothing is dropped that holds data until its replacement is filled: the old
-- `value` column is backfilled into the typed columns and dropped in the same
-- transaction (drizzle wraps every pending migration in one), so a failure
-- anywhere leaves the database exactly as it was.

-- 1. Which objects may carry custom fields. A table rather than a CHECK: the
--    owner's own entities (a later phase) are then an INSERT, not a deploy.
CREATE TABLE custom_entities (
  code text PRIMARY KEY,
  sort_order integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO custom_entities (code, sort_order) VALUES
  ('lead', 10),
  ('client', 20),
  ('receipt', 30),
  ('box', 40),
  ('crate', 50),
  ('batch', 60),
  ('plan', 70),
  ('warehouse', 80),
  ('user', 90),
  ('truck', 100),
  ('expense', 110);
--> statement-breakpoint

-- 2. The definitions table becomes platform-level.
ALTER TABLE crm_fields RENAME TO custom_fields;
--> statement-breakpoint
ALTER TABLE custom_fields RENAME CONSTRAINT crm_fields_pkey TO custom_fields_pkey;
--> statement-breakpoint
ALTER INDEX crm_fields_label_unique RENAME TO custom_fields_label_unique;
--> statement-breakpoint
ALTER TABLE custom_fields DROP CONSTRAINT crm_fields_entity_check;
--> statement-breakpoint
ALTER TABLE custom_fields ADD CONSTRAINT custom_fields_entity_fk
  FOREIGN KEY (entity_type) REFERENCES custom_entities(code);
--> statement-breakpoint
-- money (amount + currency), lookup (points at another record) and file join
-- the nine that shipped. `formula` is deliberately absent — a spreadsheet
-- engine inside a warehouse app is a project, not a field type.
ALTER TABLE custom_fields DROP CONSTRAINT crm_fields_type_check;
--> statement-breakpoint
ALTER TABLE custom_fields ADD CONSTRAINT custom_fields_type_check CHECK (type IN (
  'text', 'textarea', 'number', 'date', 'select', 'multiselect', 'checkbox',
  'phone', 'url', 'money', 'lookup', 'file'
));
--> statement-breakpoint
-- A hint under the input: the owner names a field "Kub", the warehouse asks
-- what unit, and the answer belongs next to the box rather than in a chat.
ALTER TABLE custom_fields ADD COLUMN help text;
--> statement-breakpoint
-- {min,max,minLength,maxLength,pattern} — checked on the server, and mirrored
-- onto the input so the phone objects before the round trip.
ALTER TABLE custom_fields ADD COLUMN rules jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
-- {fieldId, values:[…]} — show this field only when another one answers so.
ALTER TABLE custom_fields ADD COLUMN show_if jsonb;
--> statement-breakpoint
-- Whether the field appears as a column and a filter on the list screen.
ALTER TABLE custom_fields ADD COLUMN on_list boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- For type='lookup': which entity the answer points at.
ALTER TABLE custom_fields ADD COLUMN lookup_entity text REFERENCES custom_entities(code);
--> statement-breakpoint
ALTER TABLE custom_fields ADD CONSTRAINT custom_fields_lookup_check CHECK (
  (type = 'lookup') = (lookup_entity IS NOT NULL)
);
--> statement-breakpoint
-- Lets the values table reference (id, entity_type) as one unit, so a value
-- can never claim a field that belongs to a different object.
ALTER TABLE custom_fields ADD CONSTRAINT custom_fields_id_entity_uk UNIQUE (id, entity_type);
--> statement-breakpoint

-- 3. The answers table: typed columns instead of one jsonb blob.
ALTER TABLE crm_field_values RENAME TO custom_field_values;
--> statement-breakpoint
ALTER TABLE custom_field_values RENAME CONSTRAINT crm_field_values_pkey TO custom_field_values_pkey;
--> statement-breakpoint
ALTER INDEX crm_field_values_entity_idx RENAME TO custom_field_values_entity_idx;
--> statement-breakpoint
ALTER TABLE custom_field_values DROP CONSTRAINT crm_field_values_entity_check;
--> statement-breakpoint
ALTER TABLE custom_field_values DROP CONSTRAINT crm_field_values_field_id_fkey;
--> statement-breakpoint
ALTER TABLE custom_field_values ADD CONSTRAINT custom_field_values_field_fk
  FOREIGN KEY (field_id, entity_type) REFERENCES custom_fields(id, entity_type) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE custom_field_values
  ADD COLUMN value_text text,
  ADD COLUMN value_num numeric,
  ADD COLUMN value_date date,
  ADD COLUMN value_bool boolean,
  ADD COLUMN value_list jsonb,
  ADD COLUMN value_ref uuid,
  ADD COLUMN value_ccy varchar(3) REFERENCES currencies(code);
--> statement-breakpoint
-- Backfill from the jsonb blob, by the field's declared type. Every existing
-- row was written by coerceFieldValue, so the shapes are known exactly.
UPDATE custom_field_values v SET
  value_bool = CASE WHEN f.type = 'checkbox' THEN (v.value #>> '{}')::boolean END,
  value_num  = CASE WHEN f.type = 'number'   THEN (v.value #>> '{}')::numeric END,
  value_date = CASE WHEN f.type = 'date'     THEN (v.value #>> '{}')::date END,
  value_list = CASE WHEN f.type = 'multiselect' THEN v.value END,
  value_text = CASE
    WHEN f.type IN ('text','textarea','select','phone','url') THEN v.value #>> '{}'
  END
FROM custom_fields f
WHERE f.id = v.field_id;
--> statement-breakpoint
ALTER TABLE custom_field_values DROP COLUMN value;
--> statement-breakpoint
-- Exactly one answer per row. Money is the one type carrying two columns, and
-- a currency without an amount is not an answer.
ALTER TABLE custom_field_values ADD CONSTRAINT custom_field_values_one_value CHECK (
  (value_text IS NOT NULL)::int
  + (value_num  IS NOT NULL)::int
  + (value_date IS NOT NULL)::int
  + (value_bool IS NOT NULL)::int
  + (value_list IS NOT NULL)::int
  + (value_ref  IS NOT NULL)::int = 1
  AND (value_ccy IS NULL OR value_num IS NOT NULL)
);
--> statement-breakpoint
-- Filtering is an EXISTS over (field_id, <typed column>); these carry it.
CREATE INDEX custom_field_values_text_idx ON custom_field_values (field_id, value_text);
--> statement-breakpoint
CREATE INDEX custom_field_values_num_idx ON custom_field_values (field_id, value_num);
--> statement-breakpoint
CREATE INDEX custom_field_values_date_idx ON custom_field_values (field_id, value_date);
--> statement-breakpoint
CREATE INDEX custom_field_values_ref_idx ON custom_field_values (value_ref);
