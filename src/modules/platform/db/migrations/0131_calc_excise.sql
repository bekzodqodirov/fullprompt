-- A SPECIFIC excise can be entered (2026-10-09, docs/RASTAMOJKA-TUZATISH.md
-- P2.4, his question 2a): «$ har birlikka» — beer per litre, cigarettes per
-- thousand, fuel per litre — beside the ad-valorem `excise_pct` 0086 shipped.
-- No screen could reach excise at all until now, so every excisable good
-- priced at $0 excise and its VAT base came out short by exactly that much.
--
-- ADDITIVE and NULLABLE: no row is rewritten, no row is backfilled. The three
-- states the engine reads (pricing.ts):
--   excise_pct > 0                 → an ad-valorem excise, value × %;
--   excise_pct = 0                 → «aksiz yo'q», ANSWERED;
--   excise_specific + excise_unit  → a specific excise, measure × amount;
--   all three NULL                 → nobody has answered (the warning reads it).
-- Excise is per JOB — no dictionary carries it, and the seed writes none.
--
-- The money CHECK carries `<> 'NaN'` because postgres stores 'NaN'::numeric
-- and answers TRUE to `>= 0` (round 110's headline); the unit list is the
-- engine's `DUTY_UNITS`, the same list `calc_groups_duty_unit_check` holds.
-- ---------------------------------------------------------------------------
ALTER TABLE calc_groups ADD COLUMN excise_specific numeric(14, 4);
--> statement-breakpoint
ALTER TABLE calc_groups ADD COLUMN excise_unit text;
--> statement-breakpoint
ALTER TABLE calc_groups
  ADD CONSTRAINT calc_groups_excise_specific_check
  CHECK (excise_specific IS NULL OR (excise_specific >= 0 AND excise_specific <> 'NaN'::numeric));
--> statement-breakpoint
ALTER TABLE calc_groups
  ADD CONSTRAINT calc_groups_excise_unit_check
  CHECK (excise_unit IS NULL OR excise_unit IN ('kg', 'dona', 'litr', 'juft', '1000_dona', 'sm3', 'm2'));
--> statement-breakpoint
-- The amount and its unit are one fact: half of it prices nothing.
ALTER TABLE calc_groups
  ADD CONSTRAINT calc_groups_excise_pair_check
  CHECK ((excise_specific IS NULL) = (excise_unit IS NULL));
--> statement-breakpoint
-- ONE excise per group, never both shapes (judge MR-12). The spec's first
-- draft forbade only `excise_pct > 0` beside a specific amount, which let a
-- row read «aksiz yo'q» (pct 0) while the engine charged $X per litre. The
-- specific mode writes excise_pct NULL; «answered» is either column set.
ALTER TABLE calc_groups
  ADD CONSTRAINT calc_groups_excise_one_shape_check
  CHECK (NOT (excise_pct IS NOT NULL AND excise_specific IS NOT NULL));
