-- Prixod xabari (docs/PRIXOD-XABARI.md §E), migration 0145 — after 0144_tarkib_takliflar.
-- The owner, 2026-11-11, after the 0144 deploy: «4 ha tovar nomi, karobka soni, ogirlik va hajimga urgu
-- berilsin tekshirib olsin klient va tasdiqlasin togriligini. 8 ha. … prixod keldi desin sotuvchiga …
-- ikta button bolsin file qoshish va bitim biriktirish».
--
-- Additive: six nullable-or-defaulted columns and one CHECK re-made wider. Every existing row satisfies
-- every new CHECK, nothing is rewritten. Every new column is SQL-ONLY (never declared on its drizzle
-- table): the code of this release names them only in statements that a server one migration behind
-- either never reaches or catches (#472).

-- (a) The client's ✅ / ❌ covers the lot's weight and volume too (§A, his «4 ha»). What the message
-- SHOWED, at the precision a customer reads it — kilos to two places, cubic metres to three — rounded by
-- the database in the statement that reads the facts (`round(total_weight_kg, 2)`,
-- `round(total_volume_m3, 3)`) and compared against the same two expressions, so the two sides can never
-- round a half differently. NULL = the question did not ask about measures: every answer given before
-- this migration, and every press on a button sent before it.
ALTER TABLE "lot_client_confirms" ADD COLUMN "shown_kg" numeric(12,2);
--> statement-breakpoint
ALTER TABLE "lot_client_confirms" ADD COLUMN "shown_m3" numeric(12,3);
--> statement-breakpoint
-- Both or neither; never negative; never NaN (`<> 'NaN'` is the only comparison postgres has that
-- excludes it — NaN answers TRUE to `>= 0`).
ALTER TABLE "lot_client_confirms" ADD CONSTRAINT "lot_client_confirms_measures_check" CHECK (
  ("shown_kg" IS NULL AND "shown_m3" IS NULL)
  OR ("shown_kg" IS NOT NULL AND "shown_m3" IS NOT NULL
      AND "shown_kg" >= 0 AND "shown_kg" <> 'NaN'::numeric
      AND "shown_m3" >= 0 AND "shown_m3" <> 'NaN'::numeric)
);
--> statement-breakpoint

-- (b) What a question to the AI yordamchi cost (§B, his «8 ha»): the assistant's ledger held a count
-- and an answer and no tokens, so the evening summary could not price it. The loop already receives
-- each call's usage; it is summed and written when the question settles, in a statement of its own.
-- Rows written before this migration keep model NULL and zero tokens and are COUNTED as «narxi
-- noma'lum», never summed as $0.
ALTER TABLE "ai_questions" ADD COLUMN "model" text;
--> statement-breakpoint
ALTER TABLE "ai_questions" ADD COLUMN "input_tokens" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "ai_questions" ADD COLUMN "output_tokens" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "ai_questions" ADD COLUMN "cache_read_tokens" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "ai_questions" ADD COLUMN "cache_write_tokens" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "ai_questions" ADD CONSTRAINT "ai_questions_tokens_check" CHECK (
  "input_tokens" >= 0 AND "output_tokens" >= 0 AND "cache_read_tokens" >= 0 AND "cache_write_tokens" >= 0
);
--> statement-breakpoint

-- (c) «📎 Fayl qo‘shish» (§C.5): the staff bot's file collection for one prixod is a durable wait,
-- so a deploy between two forwards loses nothing. Widened the way 0138 and 0141 widened it — every
-- existing kind kept.
ALTER TABLE "telegram_chat_waits" DROP CONSTRAINT "telegram_chat_waits_kind_check";
--> statement-breakpoint
ALTER TABLE "telegram_chat_waits" ADD CONSTRAINT "telegram_chat_waits_kind_check" CHECK ("kind" IN (
  'task', 'staff_entry', 'ad_visit', 'cabinet_link', 'agent_edit', 'agent_price', 'agent_code', 'burst',
  'receipt_files'
));
