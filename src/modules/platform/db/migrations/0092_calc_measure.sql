-- VED 2.0 phase 3 — the item learns the law's own measure, and the request
-- learns a revision clock.
--
-- 57 of the seeded 1,489 PP-3818 rows price per juft / litr / m² / sm³ —
-- units no item column holds, so the engine has refused them since 0091
-- (`unit_unsupported`) and the screen said «bojni qo'lda kiriting». The
-- owner's answer: the code itself says the measure, so the row must ask for
-- it. kg / dona / 1000_dona deliberately do NOT join the new pair — they
-- already live on weight_kg and quantity, and a second home for one fact is
-- how two columns come to disagree about one cargo.
-- ---------------------------------------------------------------------------
ALTER TABLE calc_request_items
  ADD COLUMN IF NOT EXISTS measure_unit text,
  ADD COLUMN IF NOT EXISTS measure_qty numeric(14, 4);

ALTER TABLE calc_request_items
  ADD CONSTRAINT calc_items_measure_unit_check
  CHECK (measure_unit IS NULL OR measure_unit IN ('juft', 'litr', 'm2', 'sm3'));

-- NaN answers TRUE to >= 0 in postgres (#777) — exclude it by the only
-- comparison that can.
ALTER TABLE calc_request_items
  ADD CONSTRAINT calc_items_measure_qty_check
  CHECK (measure_qty IS NULL OR (measure_qty > 0 AND measure_qty <> 'NaN'::numeric));

-- A quantity is a statement IN a unit: neither column may stand alone, or
-- «200» survives a recode and silently becomes 200 of something else. Safe
-- as a pair CHECK because neither column is an FK (#809's trap needs one).
ALTER TABLE calc_request_items
  ADD CONSTRAINT calc_items_measure_pair_check
  CHECK ((measure_unit IS NULL) = (measure_qty IS NULL));

-- ---------------------------------------------------------------------------
-- The baza can now be priced per the law's unit too — a tile at $1/m², beer
-- at $0.5/litr. 'unit' KEEPS meaning dona (live rows and sealed breakdowns
-- store that spelling forever; a second spelling of one meaning is a trap).
-- sm3 is deliberately ABSENT from both lists: nothing is valued per cm³ of
-- engine displacement — a vehicle's baza is its invoice price per dona, and
-- offering the option would let one misclick price $15,000/cm³.
-- ---------------------------------------------------------------------------
ALTER TABLE calc_request_items DROP CONSTRAINT calc_items_baza_basis_check;
ALTER TABLE calc_request_items
  ADD CONSTRAINT calc_items_baza_basis_check
  CHECK (baza_basis IS NULL OR baza_basis IN ('unit', 'kg', 'juft', 'litr', 'm2'));

ALTER TABLE calc_bazas DROP CONSTRAINT calc_bazas_basis_check;
ALTER TABLE calc_bazas
  ADD CONSTRAINT calc_bazas_basis_check
  CHECK (basis IN ('unit', 'kg', 'juft', 'litr', 'm2'));

-- ---------------------------------------------------------------------------
-- The revision clock. The seal (and both confirm doors) compute on pool
-- reads — loadWorkspace cannot run inside a transaction (#714) — so their
-- write transactions need a way to KNOW the workspace they computed still
-- stands. A millisecond timestamp collides (two saves in one ms compare
-- equal); an integer bumped under FOR UPDATE cannot. Every workspace
-- mutator bumps it; the seal refuses `conflict` when it moved.
-- ---------------------------------------------------------------------------
ALTER TABLE calc_requests
  ADD COLUMN IF NOT EXISTS rev integer NOT NULL DEFAULT 0;
