-- 0132 — yo'lkira tarifi bo'yicha taqsimlash (docs/YOLKIRA-TAQSIMOT.md; his
-- answers 1a 2c 3a 4a 5a and his rule 6, 2026-10-14).
--
-- ADDITIVE ONLY. A sixth allocation basis, 'freight': a truck's bill split
-- over its cargo in proportion to each client's yo'lkira VALUE on his tariff
-- table, instead of by weight or volume. Two SIDE tables and not columns:
--   * warehouse_tariff_columns — which tariff column a warehouse's trucks are
--     split by (his 2c, «har bir skladga ustun yozib chiqiladi»). 50 reads go
--     through db.query.warehouses and drizzle names every column, so a column
--     on `warehouses` would 42703 nearly every page one migration behind;
--   * cost_entry_tariffs — each freight bill's FROZEN copy of the column it
--     was split by, as of its cost_date (his 3a), so a later /admin/tarif edit
--     or a warehouse remap never moves a saved bill. Same reason: a column on
--     `cost_entries` would break every cost read one migration behind.
-- A database one migration behind therefore fails only a freight write
-- (42P01 / 23514 → server_behind, by name); every other read keeps working.
--
-- Every CHECK below restates a rule its writer enforces FIRST (normaliseZone,
-- saveTariffBand's own normalisation, copyDraft's non-empty column, the
-- FREIGHT_LIGHT_BELOW constant), so none is reachable on legal input. There
-- is deliberately no zone length cap and no band-count cap: the tariff writer
-- has neither, and a cap here would turn a legal zone into an error page.
--
-- gsr_ai_reader (0080, allowlist default-deny) is granted NOTHING on either.
-- ---------------------------------------------------------------------------
ALTER TABLE "cost_entries" DROP CONSTRAINT "cost_entries_basis_check";
--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_basis_check"
  CHECK ("allocation_basis" IN ('weight', 'volume', 'chargeable', 'boxes', 'direct_to_client', 'freight'));
--> statement-breakpoint
CREATE TABLE "warehouse_tariff_columns" (
  "warehouse_id" uuid PRIMARY KEY REFERENCES "warehouses"("id") ON DELETE CASCADE,
  "tariff_zone" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "warehouse_tariff_columns_zone_check"
    CHECK ("tariff_zone" <> '' AND "tariff_zone" = lower(btrim("tariff_zone")))
);
--> statement-breakpoint
CREATE TABLE "cost_entry_tariffs" (
  "cost_entry_id" uuid PRIMARY KEY REFERENCES "cost_entries"("id") ON DELETE CASCADE,
  "warehouse_id" uuid NOT NULL REFERENCES "warehouses"("id"),
  "tariff_zone" text NOT NULL,
  "tariff_from" date NOT NULL,
  "light_below" integer NOT NULL,
  "bands" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cost_entry_tariffs_zone_check"
    CHECK ("tariff_zone" <> '' AND "tariff_zone" = lower(btrim("tariff_zone"))),
  CONSTRAINT "cost_entry_tariffs_light_check" CHECK ("light_below" BETWEEN 1 AND 1000),
  CONSTRAINT "cost_entry_tariffs_bands_check"
    CHECK (jsonb_typeof("bands") = 'array' AND jsonb_array_length("bands") >= 1)
);
