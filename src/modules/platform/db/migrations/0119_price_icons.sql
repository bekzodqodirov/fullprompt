-- «Partiya moliyasi» icons + the VED's ✅/❌ on a calc↔prixod guess (owner,
-- 2026-09-29, answers 16-20 and 26-28).
--
-- (1) `receipts.calc_link_notified_at` — when the sealer was ASKED about this
-- prixod's `auto` link. The sweep claims the rows by stamping it BEFORE the
-- message leaves (0082's drain shape), and every stamp door writes NULL, so a
-- new guess is asked about once. No refused-request column: a ❌ cannot come
-- back, because every stamp door checks `confirmed_at >= requested_at` of the
-- ONE standing request, and a correction is requested after every prixod its
-- parent could have stamped.
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS calc_link_notified_at timestamptz;
--> statement-breakpoint
-- Every guess standing today is already on /hisoblash/nazorat; pushing a year
-- of them on deploy morning would bury the VED. The home row still counts them.
UPDATE receipts SET calc_link_notified_at = now()
 WHERE calc_request_id IS NOT NULL AND calc_link_confirmed_at IS NULL;
--> statement-breakpoint
-- The sweep's own index: only the rows still owed a question.
CREATE INDEX IF NOT EXISTS receipts_calc_link_ask_idx ON receipts (calc_request_id)
 WHERE calc_request_id IS NOT NULL AND calc_link_confirmed_at IS NULL
   AND calc_link_notified_at IS NULL AND voided_at IS NULL;
--> statement-breakpoint
-- (2) `productKey()`'s twin for «Oldingi narx» (tnved/service.ts
-- `productKeySql`, which must render exactly this expression or the index is
-- never read). JS `\s` spelled out, because postgres' `\s` misses NBSP, BOM,
-- U+202F and the ideographic space; collapse, strip the one edge space the
-- collapse leaves, lower.
CREATE INDEX IF NOT EXISTS receipt_lots_product_key_idx ON receipt_lots ((lower(regexp_replace(
  regexp_replace(product_name_zh, U&'[\0009\000A\000B\000C\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+', ' ', 'g'),
  '^ | $', '', 'g'))));
--> statement-breakpoint
-- (3) The AI fallback of the icon bills a model call that belongs to no
-- calculation request: a LOT asked, not a request.
ALTER TABLE ai_calc_passes ALTER COLUMN request_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE ai_calc_passes DROP CONSTRAINT IF EXISTS ai_calc_passes_kind_check;
--> statement-breakpoint
ALTER TABLE ai_calc_passes ADD CONSTRAINT ai_calc_passes_kind_check
  CHECK (kind IN ('intake', 'grouping', 'pick', 'invoice', 'similar'));
--> statement-breakpoint
-- Exactly one anchor per kind. Safe beside the FK: it is ON DELETE CASCADE,
-- not SET NULL, so no internal UPDATE of `request_id` alone can trip it (#809).
ALTER TABLE ai_calc_passes ADD CONSTRAINT ai_calc_passes_anchor_check
  CHECK ((kind = 'similar') = (request_id IS NULL));
--> statement-breakpoint
-- What the model picked for a lot the free search found nothing for. INDEXES
-- into real past lots, resolved to their ids; the price is never stored here —
-- it is read from the ledger at render, like every other row of the icon.
CREATE TABLE IF NOT EXISTS lot_similar_picks (
  lot_id uuid PRIMARY KEY REFERENCES receipt_lots(id) ON DELETE CASCADE,
  picked_lot_ids uuid[] NOT NULL,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
