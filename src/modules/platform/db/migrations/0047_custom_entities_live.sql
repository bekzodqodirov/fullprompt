-- Phase 8: the owner's own objects become REAL rows, as #174 promised —
-- «custom entities the owner invents are rows in that table with a generic
-- card». A registry-born code keeps its label in i18n and its permissions
-- in ENTITY_SPECS; an owner-born row carries both itself, because there is
-- no release to put them in.
ALTER TABLE custom_entities ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE custom_entities ADD COLUMN IF NOT EXISTS is_custom boolean NOT NULL DEFAULT false;
-- Permission codes that may WRITE this object's records and fields
-- (ANY-of, mirroring EntitySpec.writePermissions). Empty array = any
-- signed-in member of staff; NULL = a registry code whose list lives in code.
ALTER TABLE custom_entities ADD COLUMN IF NOT EXISTS write_permissions jsonb;

-- The records themselves. Deliberately thin: a NAME everyone recognises the
-- row by, and everything else is custom fields — that is the whole point of
-- the phase. Soft-deactivated, never deleted: tasks and field answers hang
-- off the id.
CREATE TABLE IF NOT EXISTS custom_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_code text NOT NULL REFERENCES custom_entities(code),
  name text NOT NULL,
  note text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS custom_records_entity_idx
  ON custom_records (entity_code, active, name);
