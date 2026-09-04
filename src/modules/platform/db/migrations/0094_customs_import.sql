-- The customs IMPORT baza (docs/VED-IMPORT-AI.md, sub-round A).
--
-- The owner receives a quarterly dump of REAL declarations from the customs
-- service (~500k rows, one per declared goods line) and wants the VED's baza
-- filled from it: «1 tnved kodda 100lab turli hil narx bolishi mumkun, qaysi
-- narx(baz)ni olishni tovar nomi … qanchalik togriligiga qarab olamiz».
--
-- Imports ACCUMULATE (his answer 2b): a new quarter never deletes the old
-- one — suggestions read the newest ready batch, the previous quarter stays
-- readable for «bu kod avvalgi chorakda qancha edi».
CREATE TABLE "customs_import_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "file_name" text NOT NULL,
  "uploaded_by" uuid REFERENCES "users"("id"),
  "uploaded_at" timestamptz DEFAULT now() NOT NULL,
  -- 'processing' until the background job finishes; a failed batch keeps its
  -- reason on the row, because the person who uploaded it is not watching a log.
  "status" text DEFAULT 'processing' NOT NULL,
  "row_count" integer DEFAULT 0 NOT NULL,
  "skipped_rows" integer DEFAULT 0 NOT NULL,
  "period_from" date,
  "period_to" date,
  "error" text,
  CONSTRAINT "customs_import_batches_status_check"
    CHECK ("status" IN ('processing', 'ready', 'failed'))
);
--> statement-breakpoint
-- A bigint identity, not a uuid: 500k rows × 4 quarters a year, and every
-- index pays for the key width (the house shape — box_movements, events).
CREATE TABLE "customs_import_rows" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
  "batch_id" uuid NOT NULL REFERENCES "customs_import_batches"("id") ON DELETE CASCADE,
  "tnved_code" text NOT NULL,
  "name" text NOT NULL,
  -- Lowercased, «1. » prefix stripped, whitespace collapsed — what the
  -- trigram similarity is measured on. Stored because computing it per query
  -- over half a million rows is the same work done a thousand times.
  "name_norm" text NOT NULL,
  "unit" text NOT NULL,
  "price_per_unit_usd" numeric(14, 4) NOT NULL,
  -- The owner's own rule for piece goods: «donada hisoblanadgan tovarlarda
  -- har bir tovarni ogirligiga qaraymiz» — this column is what that compares.
  "weight_per_unit_kg" numeric(12, 4),
  "netto_kg" numeric(14, 3),
  "customs_value_usd" numeric(14, 2),
  "declared_at" date,
  "sender" text,
  "origin_country" text,
  CONSTRAINT "customs_import_rows_unit_check"
    CHECK ("unit" IN ('kg', 'dona', 'm2', 'juft', 'litr')),
  -- A price is a floor somebody's money is measured against: positive, never
  -- NaN (round 110's lesson — the column is written from Number() paths).
  CONSTRAINT "customs_import_rows_price_check"
    CHECK ("price_per_unit_usd" > 0 AND "price_per_unit_usd" <> 'NaN'::numeric),
  CONSTRAINT "customs_import_rows_weight_check"
    CHECK ("weight_per_unit_kg" IS NULL OR ("weight_per_unit_kg" > 0 AND "weight_per_unit_kg" <> 'NaN'::numeric))
);
--> statement-breakpoint
CREATE INDEX "customs_import_rows_batch_idx" ON "customs_import_rows" ("batch_id");
--> statement-breakpoint
-- The suggestion query is (newest batch, exact code) → rank by name
-- similarity, so the composite carries both halves of the WHERE.
CREATE INDEX "customs_import_rows_code_idx" ON "customs_import_rows" ("batch_id", "tnved_code");
--> statement-breakpoint
-- pg_trgm has been installed since 0001 — do not re-create the extension.
-- CREATE INDEX CONCURRENTLY is impossible here (drizzle wraps every pending
-- migration in ONE transaction) and unnecessary: the table is born empty.
CREATE INDEX "customs_import_rows_name_trgm_idx"
  ON "customs_import_rows" USING gin ("name_norm" gin_trgm_ops);
--> statement-breakpoint
-- Provenance for the 📥 chip: WHICH declaration row filled this baza.
-- ON DELETE SET NULL so retiring an old quarter cannot take a priced
-- calculation down with it — and deliberately NO CHECK mentioning this
-- column, because a CHECK spanning an ON DELETE SET NULL column cannot
-- coexist with it (#809, measured twice).
ALTER TABLE "calc_request_items"
  ADD COLUMN "import_row_id" bigint REFERENCES "customs_import_rows"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- 'import' joins the baza's provenance vocabulary: the customs service's own
-- recorded price, chosen by name similarity and still confirmed by a person.
-- 'ai' remains forbidden for ever — a model may propose a ROW, never a number.
ALTER TABLE "calc_request_items" DROP CONSTRAINT "calc_items_baza_source_check";
--> statement-breakpoint
ALTER TABLE "calc_request_items" ADD CONSTRAINT "calc_items_baza_source_check"
  CHECK ("baza_source" IS NULL OR "baza_source" IN ('dictionary', 'typed', 'import'));
