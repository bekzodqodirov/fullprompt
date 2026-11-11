-- Tarkib takliflari (docs/TARKIB-TAKLIFLAR.md §1.1), migration 0144 — after 0143_tarkib_document_optional.
-- The owner, 2026-11-11: «Hammasi yulduzcha javob va taklifingni qoshamiz» — the three suggestions
-- sent with the tarkib round: a tarkib filled from the client's file, the client's own ✅/❌ in
-- Telegram, and the Bojxona 🤖's bill and daily limit.
--
-- Additive: one new table, four nullable columns, two CHECKs re-made wider. Every existing row
-- satisfies every new CHECK, nothing is rewritten. Not granted to gsr_ai_reader — 0080's
-- allowlist denies a table no migration names.

-- (a) What the CLIENT answered about a lot in Telegram, and what they were SHOWN when they
-- answered (§4.1). A snapshot every reader COMPARES with the lot — `wms/receipts/lot-check-sql.ts`
-- — so no writer of those facts ever clears it, exactly as `lot_checks` (0123) works. Not a
-- `lot_checks` row: that table is «a colleague vouched» and both facts can stand together.
-- `shown_client_id`, `asked_by`: remembered values, deliberately no foreign key.
-- `shown_goods_key`: a digest of the tarkib's goods AS PRINTED (names and pieces, in order);
-- NULL = no tarkib was written. Deliberately NOT the tarkib's `rev`: that token moves on every
-- save and on every TNVED code typed on the Bojxona tab, none of which the client was shown.
CREATE TABLE "lot_client_confirms" (
  "lot_id" uuid PRIMARY KEY REFERENCES "receipt_lots"("id") ON DELETE CASCADE,
  "verdict" text NOT NULL,
  "shown_zh" text NOT NULL,
  "shown_ru" text,
  "shown_count" integer NOT NULL,
  "shown_client_id" uuid NOT NULL,
  "shown_goods_key" text,
  "chat_id" bigint NOT NULL,
  "asked_by" uuid,
  "answered_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lot_client_confirms_verdict_check" CHECK ("verdict" IN ('yes', 'no')),
  CONSTRAINT "lot_client_confirms_count_check" CHECK ("shown_count" > 0),
  CONSTRAINT "lot_client_confirms_ru_check" CHECK ("shown_ru" IS NULL OR "shown_ru" <> '')
);
--> statement-breakpoint

-- (b) Who pressed «Mijozdan so'rash» (§4.1) — on the notice, so the answer can tell them.
-- SQL-ONLY: never declared on the drizzle table. `claimReceivedNotice` inserts through drizzle
-- inside confirmReceipt's transaction, and a declared column is a 42703 on a server one
-- migration behind — every prixod refused (#472).
ALTER TABLE "client_notices" ADD COLUMN "asked_by" uuid;
--> statement-breakpoint

-- (c) A pressed model call that belongs to no calc request — the Bojxona 🤖 ('tnved') and the
-- tarkib's file reading ('tarkib') — is a row of the one AI ledger (§1.3): counted when it is
-- RESERVED, billed when the model answers. The three columns are SQL-only on the drizzle table
-- too: `recordAiPass` inserts through drizzle and swallows its own failure, so a declared
-- column would silently lose every calc bill of a half-applied deploy.
ALTER TABLE "ai_calc_passes" ADD COLUMN "lot_id" uuid;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD COLUMN "batch_id" uuid;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD COLUMN "outcome" text;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD CONSTRAINT "ai_calc_passes_outcome_check"
  CHECK ("outcome" IS NULL OR "outcome" IN ('reserved', 'ok', 'failed', 'no_answer'));
--> statement-breakpoint
-- What an answered call cost at list price, FROZEN on the row when the press
-- is settled. A price computed at read time from a map keyed by today's
-- model would re-price last month's rows the day the model changes — or lose
-- their price altogether. NULL = no price known for that model (said on the
-- screen as a count), or a press that got no answer.
ALTER TABLE "ai_calc_passes" ADD COLUMN "cost_usd" numeric(12,6);
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD CONSTRAINT "ai_calc_passes_cost_check"
  CHECK ("cost_usd" IS NULL OR "cost_usd" >= 0);
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" DROP CONSTRAINT IF EXISTS "ai_calc_passes_kind_check";
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD CONSTRAINT "ai_calc_passes_kind_check"
  CHECK ("kind" IN ('intake', 'grouping', 'pick', 'invoice', 'similar', 'tnved', 'tarkib'));
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" DROP CONSTRAINT IF EXISTS "ai_calc_passes_anchor_check";
--> statement-breakpoint
-- One anchor per kind. The two pressed kinds stand on a LOT and nothing else.
ALTER TABLE "ai_calc_passes" ADD CONSTRAINT "ai_calc_passes_anchor_check" CHECK (
  CASE "kind"
    WHEN 'similar' THEN "request_id" IS NULL AND "intake_note_id" IS NULL
    WHEN 'intake' THEN "request_id" IS NOT NULL OR "intake_note_id" IS NOT NULL
    WHEN 'tnved' THEN "lot_id" IS NOT NULL AND "request_id" IS NULL AND "intake_note_id" IS NULL
    WHEN 'tarkib' THEN "lot_id" IS NOT NULL AND "request_id" IS NULL AND "intake_note_id" IS NULL
    ELSE "request_id" IS NOT NULL AND "intake_note_id" IS NULL
  END
);
--> statement-breakpoint
-- The cap and the number shown count one kind's rows of one day.
CREATE INDEX "ai_calc_passes_kind_day_idx" ON "ai_calc_passes" ("kind", "created_at");
