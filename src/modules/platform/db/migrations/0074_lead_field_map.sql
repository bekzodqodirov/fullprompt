-- The tarjimon (round 97): an advert form's own questions become lead fields.
--
-- A Meta or webhook form asks whatever its builder typed («bazada yukingiz
-- bormi», «necha kub»); until now every answer landed on the lenta as a text
-- line. This maps a QUESTION KEY to a structured target once, and every later
-- arrival fills the lead in. Everything additive.

-- One decision per question key. `target`:
--   kub / kg  -> the lead's quoted volume / weight (new leads only);
--   field     -> a lead custom field (field_id required);
--   note      -> «leave it in the note» — a DECISION, stored, so the key stops
--                reappearing in the unmapped list (round 82's include/exclude
--                lesson: a question somebody answered must not be re-asked).
-- The FK CASCADEs: a mapping is derived configuration, meaningless without
-- its field — deleting the field must not strand a row that blocks the
-- custom-fields admin with a raw 23503.
CREATE TABLE lead_field_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  target text NOT NULL,
  field_id uuid REFERENCES custom_fields(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_field_map_target_check
    CHECK (target IN ('kub', 'kg', 'field', 'note')),
  CONSTRAINT lead_field_map_field_check
    CHECK ((target = 'field') = (field_id IS NOT NULL))
);

-- The raw question/answer pairs of an arrival, capped in code (30 pairs,
-- short keys/values) — the «seen questions» list the mapping screen reads.
-- Null for every historical row and for doors that carry no questions.
ALTER TABLE lead_intakes ADD COLUMN fields jsonb;

-- «Kubdan katta bo'lsa bunga» — the routing rule's volume window. Matched
-- against the mapped kub answer, or a volume read from the arrival's own
-- text, so the /ariza door is not structurally deaf to it.
ALTER TABLE inbound_routes ADD COLUMN min_m3 numeric(12, 3);
ALTER TABLE inbound_routes ADD COLUMN max_m3 numeric(12, 3);
