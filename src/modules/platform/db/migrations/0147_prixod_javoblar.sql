-- Prixod javoblari (docs/PRIXOD-JAVOBLAR.md), migration 0147 — after 0146_prixod_xabari.
-- The owner, 2026-11-12, answering the round's seven questions: «1 b / 2 b / 4 b» — the client is asked
-- again BY ITSELF when the cargo is re-weighed (1b), and a colleague's «✅ To'g'ri» stops vouching when
-- the kilos or the cubic metres move, as the client's own ✅ already does (2b).
--
-- Additive: four nullable columns and two CHECKs; one backfill that writes only the new columns. Every
-- new column is SQL-ONLY (never declared on its drizzle table): the code of this release names them
-- only in statements a server one migration behind either never reaches or asks the probe first
-- (`wms/receipts/lot-check-ready.ts`, #472).

-- (a) The colleague's tick remembers the lot's kilos and cubic metres (§2.2, his «2 b»), at the
-- precision a customer and a list read them — kilos to two places, cubic metres to three — rounded by
-- the DATABASE in the statement that writes them and compared against the same two expressions
-- (`lotShownKgSql` / `lotShownM3Sql`), the client's full ✅'s own rule (0146). NULL = a tick that said
-- nothing about the measures: a row an OLD process writes in the minutes between this migration and its
-- own restart.
ALTER TABLE "lot_checks" ADD COLUMN "seen_kg" numeric(12,2);
--> statement-breakpoint
ALTER TABLE "lot_checks" ADD COLUMN "seen_m3" numeric(12,3);
--> statement-breakpoint
-- Both or neither; never negative; never NaN (`<> 'NaN'` is the only comparison postgres has that
-- excludes it — NaN answers TRUE to `>= 0`).
ALTER TABLE "lot_checks" ADD CONSTRAINT "lot_checks_seen_measures_check" CHECK (
  ("seen_kg" IS NULL AND "seen_m3" IS NULL)
  OR ("seen_kg" IS NOT NULL AND "seen_m3" IS NOT NULL
      AND "seen_kg" >= 0 AND "seen_kg" <> 'NaN'::numeric
      AND "seen_m3" >= 0 AND "seen_m3" <> 'NaN'::numeric)
);
--> statement-breakpoint
-- Every tick that already stands takes the lot's figures as they are TODAY: nothing moves on the day of
-- the deploy, and from then on a re-weigh makes every tick «o'zgardi» — old ones included, which is what
-- his «ha» asked. (What the lot weighed on the day of an old tick was never recorded; the deploy day's
-- figures are the honest snapshot.) A lot whose totals are NaN or negative keeps NULL and holds on its
-- other three terms, as before.
UPDATE "lot_checks" AS k
   SET "seen_kg" = round(l."total_weight_kg", 2),
       "seen_m3" = round(l."total_volume_m3", 3)
  FROM "receipt_lots" AS l
 WHERE l."id" = k."lot_id"
   AND l."total_weight_kg" >= 0 AND l."total_weight_kg" <> 'NaN'::numeric
   AND l."total_volume_m3" >= 0 AND l."total_volume_m3" <> 'NaN'::numeric;
--> statement-breakpoint

-- (b) What the client was last ASKED (§1.5, his «1 b»): the tag of the last question with buttons a
-- notice row delivered, and when. Written right after a delivery the sweep settled as sent, by the sweep
-- itself; never cleared by a later outcome — a row re-armed and then refused still remembers the message
-- the client is holding. The automatic re-ask compares it with what a question would print NOW.
ALTER TABLE "client_notices" ADD COLUMN "asked_tag" text;
--> statement-breakpoint
ALTER TABLE "client_notices" ADD COLUMN "asked_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "client_notices" ADD CONSTRAINT "client_notices_asked_check" CHECK (
  ("asked_tag" IS NULL AND "asked_at" IS NULL)
  OR ("asked_tag" IS NOT NULL AND "asked_at" IS NOT NULL AND "asked_tag" ~ '^[0-9a-f]{8}$')
);
