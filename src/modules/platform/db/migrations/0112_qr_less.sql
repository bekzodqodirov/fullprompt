-- QR-siz qabul va yuklash (owner, 2026-09-27, Q1-Q10: «hamma karobkani ham
-- qr code qilish imkoni bo'lmay qolyabti … admin va logist tomonidan qabul
-- qilib qolish va yuklash»). Additive only: every new column is nullable with
-- no default, so no existing row changes meaning and no table is rewritten.

-- Q8 «QR yopishtirilmadi»: WHEN the lot was declared stickerless. A carton is
-- QR-siz when it is uncrated, its lot is marked, and its label_printed_at is
-- NULL or older than this stamp (labels/qrless-sql.ts is the one home of that
-- sentence). A timestamp and not a boolean: sacks get re-marked after a
-- sheet is finally stuck on, and only the later stamp can say which cartons
-- the sheet covered. NULL = every existing lot, unchanged.
ALTER TABLE "receipt_lots" ADD COLUMN "qr_skipped_at" timestamptz;
CREATE INDEX "receipt_lots_qr_skipped_idx" ON "receipt_lots" ("id") WHERE "qr_skipped_at" IS NOT NULL;

-- Q10 c: the factory's own barcode, one per lot, stored as a canonical key
-- (receipts/factory-barcode.ts keeps the same regex). It names a PRODUCT, and
-- one product arrives in many prixods, so it is deliberately not unique.
ALTER TABLE "receipt_lots" ADD COLUMN "factory_barcode" text;
ALTER TABLE "receipt_lots" ADD CONSTRAINT "receipt_lots_factory_barcode_check"
  CHECK ("factory_barcode" IS NULL OR "factory_barcode" ~ '^[A-Z0-9./+-]{4,48}$');
CREATE INDEX "receipt_lots_factory_barcode_idx" ON "receipt_lots" ("factory_barcode")
  WHERE "factory_barcode" IS NOT NULL;

-- Q9 b: who PHYSICALLY received a prixod the office entered on their behalf —
-- a colleague picked from the warehouse's people, or a typed name (a driver,
-- a loader with no login). Both NULL = «the person who pressed», which is
-- what every existing row means.
ALTER TABLE "receipts" ADD COLUMN "received_by_user_id" uuid REFERENCES "users"("id");
ALTER TABLE "receipts" ADD COLUMN "received_by_name" text;
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_received_by_one"
  CHECK ("received_by_user_id" IS NULL OR "received_by_name" IS NULL);
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_received_by_name_len"
  CHECK ("received_by_name" IS NULL OR char_length(btrim("received_by_name")) BETWEEN 2 AND 120);

-- Q10 d: a pallet is a crate — one CR- label, one place. The swap validates
-- every existing yashik/karkas row against the new list.
ALTER TABLE "crates" DROP CONSTRAINT "crates_kind_check";
ALTER TABLE "crates" ADD CONSTRAINT "crates_kind_check" CHECK ("kind" IN ('yashik', 'karkas', 'palet'));

-- Q4: «this lot was already counted on this truck», asked on every phone scan
-- of a loose carton. Partial: count events are a sliver of the table. The IN
-- list is pinned against COUNT_REASONS (scanning/count-rules.ts) by a unit
-- test, because a reason added there and not here is a Seq Scan per scan.
CREATE INDEX "scan_events_count_idx" ON "scan_events" ("batch_id", "box_id")
  WHERE "manual_reason" IN ('count_load', 'count_accept', 'count_over');

-- Q1 «sekin»: every scan resolves its code with upper(short_code) = $1, and
-- boxes_short_code_unique indexes short_code as written — so all nine of those
-- lookups were a Seq Scan over every carton the company ever received. The
-- expression index serves them with no code change.
CREATE INDEX "boxes_short_code_upper_idx" ON "boxes" (upper("short_code"));
