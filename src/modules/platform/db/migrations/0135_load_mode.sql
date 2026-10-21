-- LTL / FTL (the owner, 2026-10-20: «bizni sohada LTL FTL degan narsalar bor biz odatda LTL boyicha ishlaymiz
-- va KPI sovrinlar shu LTL boyicha hsoblanadi agarda FTL bolsa bunga kpi yozilmaydi va olib kelgan yuki KPI ga
-- kirmaydi … gamificationda FTL va LTL birga qoshilib ketyapti», answers 1a 2a 3b 4a 5a 6a 7a).
--
-- Three SIDE tables and not a column on leads / deals / receipts: drizzle names every declared column in every
-- whole-row read and every INSERT … RETURNING, and those three tables carry ~75 such reads — the receive
-- confirm, both CRM boards, every card. A column declared there would answer all of them 42703 on a database
-- one migration behind (#1381's reason for a side table; #735: a half-applied deploy must not take down
-- receiving). Absence of a row is LTL — the default his business runs on — so nothing is backfilled and every
-- machine creator (the bot intake, the auto-deal, inbound adverts) writes LTL by construction.
--
-- lead_ftl / deal_ftl: a row = the lead / deal is FTL. `marked_by` + `by_office` decide how far the mark
--   reaches: an office mark (admin, logist, accountant) passes to every prixod of the deal's client, a seller's
--   own mark only to the cargo stamped to HIM (a seller must never cut a colleague's KPI).
-- receipt_load_mode: no row = LTL, following its deal. A row is either an INHERITED FTL (hand = false, the deal
--   it came FROM named — the office's revert of that deal takes back exactly what that deal gave) or a person's
--   HAND decision on the prixod card (hand = true, ltl or ftl, which a deal change never overrides).
--   `by_office` says whether the office wrote it: a client correction takes back a seller's own mark (it would
--   otherwise land on the new client's seller) and keeps the office's (wms/ftl/service.ts).
--
-- gsr_ai_reader (0080, allowlist default-deny) is granted NOTHING on these tables (stated).
-- The users FKs are SET NULL (a test suite deletes fixture users; jamoa guruhi's reason). An inherited row
-- CASCADEs with the deal it came from — its whole meaning is «that deal said so» — and a hand row names no
-- deal, so the CHECK never spans a column a delete would null (#809).
CREATE TABLE "lead_ftl" (
  "lead_id" uuid PRIMARY KEY REFERENCES "leads"("id") ON DELETE CASCADE,
  "marked_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "by_office" boolean NOT NULL,
  "marked_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "deal_ftl" (
  "deal_id" uuid PRIMARY KEY REFERENCES "deals"("id") ON DELETE CASCADE,
  "marked_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "by_office" boolean NOT NULL,
  "marked_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "receipt_load_mode" (
  "receipt_id" uuid PRIMARY KEY REFERENCES "receipts"("id") ON DELETE CASCADE,
  "mode" text NOT NULL,
  "hand" boolean NOT NULL,
  "by_office" boolean NOT NULL DEFAULT false,
  "from_deal_id" uuid REFERENCES "deals"("id") ON DELETE CASCADE,
  "set_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "receipt_load_mode_mode_check" CHECK ("mode" IN ('ltl', 'ftl')),
  CONSTRAINT "receipt_load_mode_shape_check" CHECK (
    ("hand" AND "from_deal_id" IS NULL) OR (NOT "hand" AND "mode" = 'ftl' AND "from_deal_id" IS NOT NULL)
  )
);

CREATE INDEX "receipt_load_mode_deal_idx" ON "receipt_load_mode" ("from_deal_id") WHERE "from_deal_id" IS NOT NULL;

-- The departure hint's «never the same prixod twice» reads only its own notices (ftl/hint.ts): without this
-- the dedupe is a sequential scan of every notification ever sent, inside the warehouse's depart press.
CREATE INDEX "notifications_ftl_hint_idx" ON "notifications" ("created_at") WHERE "type" = 'FtlSuspected';
