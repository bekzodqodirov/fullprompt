-- VED 2.0 phase 1 — the law engine's columns (PP-3818 + the 2026 guide).
--
-- The duty on a TNVED code is not one number. PP-3818 prices 1,489 rows in
-- FOUR shapes: advalor (BQ × S%), specific (Miqdor × T per unit), MAX of the
-- two (198 rows — «20%, lekin 3 AQSH dollaridan kam emas»), and their SUM
-- (41 vehicle rows). A schema that holds only `duty_pct` can store the 20 and
-- silently lose the $3/dona floor — which on light goods IS the duty. So the
-- mode and the specific half become columns, on the dictionary AND on the
-- group snapshot, because a sealed price must go on reading its own law after
-- the dictionary moves.

-- ---------------------------------------------------------------------------
-- The dictionary.
-- ---------------------------------------------------------------------------
ALTER TABLE calc_rates
  ADD COLUMN IF NOT EXISTS duty_mode text NOT NULL DEFAULT 'advalor',
  ADD COLUMN IF NOT EXISTS duty_specific numeric(12, 4),
  ADD COLUMN IF NOT EXISTS duty_unit text;

ALTER TABLE calc_rates
  ADD CONSTRAINT calc_rates_duty_mode_check
  CHECK (duty_mode IN ('advalor', 'specific', 'max', 'plus'));

-- The unit the specific half is per, verbatim from PP-3818's own vocabulary.
-- The ENGINE prices only kg / dona / 1000_dona (the measures a calc request
-- actually carries) and refuses the rest with `unit_unsupported` — but the
-- DICTIONARY stores all seven, because the law names all seven and a seed
-- that dropped litr rows would answer «no rate» about codes the law prices.
ALTER TABLE calc_rates
  ADD CONSTRAINT calc_rates_duty_unit_check
  CHECK (duty_unit IS NULL OR duty_unit IN ('kg', 'dona', 'litr', 'juft', '1000_dona', 'sm3', 'm2'));

-- NaN answers TRUE to >= 0 in postgres (round 110's find, #777) — exclude it
-- by the only comparison that can.
ALTER TABLE calc_rates
  ADD CONSTRAINT calc_rates_specific_check
  CHECK (duty_specific IS NULL OR (duty_specific >= 0 AND duty_specific <> 'NaN'::numeric));

-- Two-directional: an advalor row carries NO specific half, and every other
-- mode carries BOTH halves. One direction alone lets a 'max' row lose its
-- floor and quietly become the plain percentage it was created to beat.
ALTER TABLE calc_rates
  ADD CONSTRAINT calc_rates_mode_pair_check
  CHECK (
    ((duty_mode = 'advalor') = (duty_specific IS NULL))
    AND ((duty_mode = 'advalor') = (duty_unit IS NULL))
  );

-- The seed is its own source: a person's later correction must be tellable
-- from the law's own text a year on.
ALTER TABLE calc_rates DROP CONSTRAINT calc_rates_source_check;
ALTER TABLE calc_rates
  ADD CONSTRAINT calc_rates_source_check
  CHECK (source IN ('manual', 'correction', 'pp3818'));

-- ---------------------------------------------------------------------------
-- The request: the certificate, and the per-declaration fee's override.
--
-- `has_certificate` defaults TRUE by the owner's own answer («ha sertifikat
-- bor deb qoy») — without an origin certificate the 28.02.2026 additional
-- duty adds 5-20 % by value band, so the flag flips the whole calculation.
-- Per REQUEST and inheritable per group, because a sborniy truck mixes
-- senders (judge J21).
--
-- `fee_override_usd` exists because the BHM step scale prices a DECLARATION
-- and this system prices a REQUEST — usually the same thing, not always. A
-- typed override wins over the computed tier; NULL means «compute it».
-- ---------------------------------------------------------------------------
ALTER TABLE calc_requests
  ADD COLUMN IF NOT EXISTS has_certificate boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS fee_override_usd numeric(12, 2);

ALTER TABLE calc_requests
  ADD CONSTRAINT calc_requests_fee_override_check
  CHECK (fee_override_usd IS NULL OR (fee_override_usd >= 0 AND fee_override_usd <> 'NaN'::numeric));

-- ---------------------------------------------------------------------------
-- The group snapshot. All nullable: NULL `duty_mode` reads as 'advalor', so
-- every group sealed before this migration keeps meaning exactly what it
-- meant. `has_certificate` NULL inherits the request's answer; `excise_pct`
-- NULL means none (the common case — excise names a short list of goods).
-- ---------------------------------------------------------------------------
ALTER TABLE calc_groups
  ADD COLUMN IF NOT EXISTS duty_mode text,
  ADD COLUMN IF NOT EXISTS duty_specific numeric(12, 4),
  ADD COLUMN IF NOT EXISTS duty_unit text,
  ADD COLUMN IF NOT EXISTS excise_pct numeric(6, 3),
  ADD COLUMN IF NOT EXISTS has_certificate boolean;

ALTER TABLE calc_groups
  ADD CONSTRAINT calc_groups_duty_mode_check
  CHECK (duty_mode IS NULL OR duty_mode IN ('advalor', 'specific', 'max', 'plus'));

ALTER TABLE calc_groups
  ADD CONSTRAINT calc_groups_duty_unit_check
  CHECK (duty_unit IS NULL OR duty_unit IN ('kg', 'dona', 'litr', 'juft', '1000_dona', 'sm3', 'm2'));

ALTER TABLE calc_groups
  ADD CONSTRAINT calc_groups_specific_check
  CHECK (duty_specific IS NULL OR (duty_specific >= 0 AND duty_specific <> 'NaN'::numeric));

ALTER TABLE calc_groups
  ADD CONSTRAINT calc_groups_excise_check
  CHECK (excise_pct IS NULL OR (excise_pct >= 0 AND excise_pct <= 100));

-- Same pair rule as the dictionary, read through the NULL-means-advalor lens.
ALTER TABLE calc_groups
  ADD CONSTRAINT calc_groups_mode_pair_check
  CHECK (
    ((coalesce(duty_mode, 'advalor') = 'advalor') = (duty_specific IS NULL))
    AND ((coalesce(duty_mode, 'advalor') = 'advalor') = (duty_unit IS NULL))
  );
