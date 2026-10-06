-- The baza can be priced per cubic metre (his answer 19a, 2026-10-06), and the
-- customs file's «м3» declarations stop being skipped.
--
-- CHECK-only and strictly WIDER: every stored row already passes the new
-- lists, so nothing is rewritten and nothing is backfilled. The spelling is
-- 'm3' beside 'm2' — the one the codebase already uses for a cubic metre
-- (`calc_price_book_unit_check`). 'unit' keeps meaning dona forever.
--
-- An m³ baza reads the row's EXISTING `volume_m3` (numeric(12,3)) — no new
-- column and no second home for one fact (#868). The measure pair
-- (`measure_unit`/`measure_qty`), its CHECKs and both `duty_unit` CHECKs are
-- deliberately untouched: PP-3818 writes no duty per m³, so the law's own
-- measure never needs the unit. What the baza is PER and what the duty
-- COUNTS are two questions with two homes.
--
-- Plain DROP/ADD: re-validating a wider list scans each table once inside
-- the migration's own transaction, and `NOT VALID` would save nothing there
-- while leaving the constraint unvalidated in the catalog for good.
-- ---------------------------------------------------------------------------
ALTER TABLE calc_request_items DROP CONSTRAINT calc_items_baza_basis_check;
--> statement-breakpoint
ALTER TABLE calc_request_items
  ADD CONSTRAINT calc_items_baza_basis_check
  CHECK (baza_basis IS NULL OR baza_basis IN ('unit', 'kg', 'm3', 'm2', 'juft', 'litr'));
--> statement-breakpoint
ALTER TABLE calc_bazas DROP CONSTRAINT calc_bazas_basis_check;
--> statement-breakpoint
ALTER TABLE calc_bazas
  ADD CONSTRAINT calc_bazas_basis_check
  CHECK (basis IN ('unit', 'kg', 'm3', 'm2', 'juft', 'litr'));
--> statement-breakpoint
-- The quarterly file's unit. Quarters uploaded before this skipped their м3
-- lines as `unknown_unit`; only a NEW upload brings them in.
ALTER TABLE customs_import_rows DROP CONSTRAINT customs_import_rows_unit_check;
--> statement-breakpoint
ALTER TABLE customs_import_rows
  ADD CONSTRAINT customs_import_rows_unit_check
  CHECK (unit IN ('kg', 'dona', 'm3', 'm2', 'juft', 'litr'));
