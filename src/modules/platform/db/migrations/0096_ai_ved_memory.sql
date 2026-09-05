-- AI-VED (rastamojka) — the sealed memory, the pick's reason, the correction
-- fence and the AI cost ledger. Additive; nothing existing changes meaning.
--
-- The owner, 2026-09-05: «telegramda AI ning o'zi tahminiy rastamojkani
-- hisoblab bersin … shu muhrlangan datani AI xotirasiga qo'yish kerak».
-- What a VED SEALED is the company's own confirmed answer, so it is the first
-- place the machine looks the next time a similar product name arrives —
-- ahead of the dictionaries, the quarterly customs file and the model.
--
-- There is no new memory TABLE, on purpose. The memory is the sealed record
-- itself (`lgotaLastByCode`'s rule, #767): a second copy of a price can
-- disagree with the seal it was copied from and nothing could tell which is
-- true. What this migration adds is the PROVENANCE of a memory-filled row,
-- the normalised name the search needs, and an index to make it cheap.

-- 1. Provenance. `memory_item_id` names the sealed ITEM a baza was copied
--    from — the 🧠 chip's title reads it back («V2 · 04.09 · VED Demo»).
--    ON DELETE SET NULL, and therefore NO CHECK may mention this column:
--    a CHECK spanning an ON DELETE SET NULL column cannot coexist with it
--    (#809, measured twice, written wrong twice).
ALTER TABLE "calc_request_items"
  ADD COLUMN "memory_item_id" uuid REFERENCES "calc_request_items"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- 2. The model's one-line REASON for choosing one declaration over another
--    (owed since #909: a pick and the deterministic ≥0.45 auto-fill landed
--    identically, and the VED reviewing a number could not tell which of the
--    two put it there). Words only — the number still comes from the file.
ALTER TABLE "calc_request_items" ADD COLUMN "baza_reason" text;
--> statement-breakpoint
-- 3. 'memory' joins the baza's provenance vocabulary. It is not a new kind of
--    guess: it is a price a PERSON confirmed and sealed on an earlier job.
--    'ai' remains forbidden for ever — the model proposes a row, never a
--    number (law 1, pinned by tests/unit/ai-advisory.test.ts).
ALTER TABLE "calc_request_items" DROP CONSTRAINT "calc_items_baza_source_check";
--> statement-breakpoint
ALTER TABLE "calc_request_items" ADD CONSTRAINT "calc_items_baza_source_check"
  CHECK ("baza_source" IS NULL OR "baza_source" IN ('dictionary', 'typed', 'import', 'memory'));
--> statement-breakpoint
-- 4. The name the memory searches on. Written by ONE helper (`itemNameNorm`)
--    at every item writer rather than by a trigger, so the audit row and the
--    transaction discipline see it like any other column.
ALTER TABLE "calc_request_items" ADD COLUMN "name_norm" text;
--> statement-breakpoint
UPDATE "calc_request_items"
   SET "name_norm" = lower(regexp_replace(btrim("name"), '\s+', ' ', 'g'))
 WHERE "name_norm" IS NULL;
--> statement-breakpoint
-- pg_trgm has been installed since 0001 — do not re-create the extension.
-- CREATE INDEX CONCURRENTLY is impossible (drizzle wraps every pending
-- migration in ONE transaction); this table holds hundreds of rows.
CREATE INDEX "calc_items_name_norm_trgm_idx"
  ON "calc_request_items" USING gin ("name_norm" gin_trgm_ops);
--> statement-breakpoint
-- 5. ONE correction per sealed request (audit A11). Two people pressing
--    «Qayta hisoblash» in the same second used to mint two children off one
--    parent, and BOTH then stood: `notSupersededSql` sees no child on either,
--    so `payableOffersSql` pays the seller's commission twice for one sale
--    and `stampCalcLink`'s «exactly one sealed request» can no longer choose.
--    The service's own guard is the parent's `FOR UPDATE` + an in-transaction
--    re-check; this index is the database saying the same thing.
--
--    Guarded, because a UNIQUE index that cannot be built would stop the
--    whole deploy with a cryptic message. If a duplicate pair already exists,
--    the deploy stops with a SENTENCE naming the parent instead.
DO $$
DECLARE dup uuid;
BEGIN
  SELECT supersedes_request_id INTO dup
    FROM calc_requests
   WHERE supersedes_request_id IS NOT NULL
   GROUP BY supersedes_request_id
  HAVING count(*) > 1
   LIMIT 1;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'Bitta muhrlangan hisobdan ikkita qayta hisob bor (ota so''rov: %). Avval bittasini yoping, keyin yangilashni qayta ishga tushiring.', dup;
  END IF;
  CREATE UNIQUE INDEX calc_requests_supersedes_uniq
    ON calc_requests (supersedes_request_id)
    WHERE supersedes_request_id IS NOT NULL;
END $$;
--> statement-breakpoint
-- 6. What the AI pass cost, per calculation. Deliberately NOT `ai_questions`:
--    that table is the assistant's audit AND its atomic per-person daily cap
--    (`user_id` NOT NULL), and this pass runs as NOBODY — a background job on
--    a request, sometimes with no staff member to bill it to. One row per
--    model call, so a week of real use can be read as a bill.
CREATE TABLE "ai_calc_passes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_id" uuid NOT NULL REFERENCES "calc_requests"("id") ON DELETE CASCADE,
  "staff_id" uuid REFERENCES "users"("id"),
  "kind" text NOT NULL,
  "model" text NOT NULL,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ai_calc_passes_kind_check"
    CHECK ("kind" IN ('intake', 'grouping', 'pick', 'invoice')),
  CONSTRAINT "ai_calc_passes_tokens_check"
    CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0)
);
--> statement-breakpoint
-- The budget question is «how many calls today», so the day is the index.
CREATE INDEX "ai_calc_passes_day_idx" ON "ai_calc_passes" ("created_at");
