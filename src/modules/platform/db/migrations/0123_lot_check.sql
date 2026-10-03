-- Yuk ma'lumoti tekshiruvi (the owner, 2026-10-03, answers 1a 2b 3a 4a 5b;
-- docs/YUK-TEKSHIRUV.md): a person confirmed with the client that a lot is
-- what the warehouse wrote — «100 karobkangiz keldi, klaviatura ekan,
-- to'g'rimi?». One row per lot, holding WHAT was vouched for (his 2b: the
-- goods name, the carton count and the client), so a later rename, a count
-- correction or a new client reads «o'zgardi — qayta so'rang» by comparison,
-- with no writer of those facts having to know this table exists.
--
-- The other basis — a lot tarkibi stated against the client's document (his
-- 3a) — is NOT a row here: it is the composition itself, read through its
-- own staleness rule, so the shipped lot tarkibi needs no second writer.
--
-- `seen_client_id` carries no FK on purpose: it is a remembered value
-- compared with `receipts.client_id`, not a relation.
-- Not granted to gsr_ai_reader — 0080's allowlist denies a table no
-- migration names (0122's precedent).
CREATE TABLE "lot_checks" (
  "lot_id" uuid PRIMARY KEY REFERENCES "receipt_lots"("id") ON DELETE CASCADE,
  "seen_name_zh" text NOT NULL,
  "seen_name_ru" text,
  "seen_box_count" integer NOT NULL,
  "seen_client_id" uuid NOT NULL,
  "note" text,
  "checked_by" uuid NOT NULL REFERENCES "users"("id"),
  "checked_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lot_checks_seen_box_count_check" CHECK ("seen_box_count" > 0),
  -- NULL, never '': the lot column stores an absent Russian name as NULL, and
  -- the comparison is IS NOT DISTINCT FROM — an '' here would read «renamed»
  -- on every lot that has none.
  CONSTRAINT "lot_checks_seen_name_ru_check" CHECK ("seen_name_ru" IS NULL OR "seen_name_ru" <> ''),
  CONSTRAINT "lot_checks_note_check" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500)
);
