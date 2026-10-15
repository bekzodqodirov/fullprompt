-- 0133 — zavod reysi yopiladi, prixod qatorni eslab qoladi
-- (docs/ZAVOD-YOPISH.md; the owner's «zavot partiyalarni yuklagandan keyin
-- qabul qilib olsa ham keyinchalik yana reyslar chiqib qolyabti», answers
-- 1a 2a 3a 4a 5a, 2026-10-15).
--
-- ADDITIVE. A trip had no finished state, and «is this line received» was
-- recomputed on every read by matching the line's client id or marking text
-- against the prixods linked to its stop — so claiming an unclaimed marking,
-- voiding a prixod, or any later cargo of the same client brought an old trip
-- back, and the /receive list even let the same cargo be received twice.
--
--   * pickups.status gains 'closed' — terminal, never reopened (his 2a). The
--     close facts are columns on `pickups` and not a side table, because the
--     pair CHECK below is what makes «closed» and «has a closed_at» one fact;
--     every pickups reader is a logist screen or caught (#472), and the app
--     waits on `migrate` (service_completed_successfully).
--   * the «xarajat yo'q» mark (his 5a): a reason, who, when.
--   * pickup_line_receipts — which lines a prixod ANSWERS, written once when
--     it is linked. A side table: 45 whole-row reads of `receipts` would 42703
--     one migration behind (0132's reason).
--
-- gsr_ai_reader (0080, allowlist default-deny) is granted NOTHING on the new
-- table; the new pickups columns are not in its column grants either.
-- ---------------------------------------------------------------------------
ALTER TABLE "pickups" DROP CONSTRAINT "pickups_status_check";
--> statement-breakpoint
ALTER TABLE "pickups" ADD CONSTRAINT "pickups_status_check"
  CHECK ("status" IN ('planned', 'on_road', 'arrived', 'closed', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "pickups"
  ADD COLUMN "closed_at" timestamptz,
  ADD COLUMN "closed_by" uuid REFERENCES "users"("id"),
  ADD COLUMN "close_kind" text,
  ADD COLUMN "close_reason" text,
  ADD COLUMN "no_cost_at" timestamptz,
  ADD COLUMN "no_cost_by" uuid REFERENCES "users"("id"),
  ADD COLUMN "no_cost_reason" text;
--> statement-breakpoint
-- «Closed» and «has a close» are one fact; an auto close carries no reason, a
-- manual one carries a sentence (his 1a: «sababi yoziladi»).
ALTER TABLE "pickups" ADD CONSTRAINT "pickups_closed_check" CHECK (
  ("status" = 'closed') = ("closed_at" IS NOT NULL)
  AND ("closed_at" IS NULL) = ("close_kind" IS NULL)
  AND ("close_kind" IS NULL OR "close_kind" IN ('auto', 'manual'))
  AND ("close_kind" IS DISTINCT FROM 'manual' OR char_length(btrim("close_reason")) BETWEEN 3 AND 500)
  AND ("close_kind" IS DISTINCT FROM 'auto' OR "close_reason" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "pickups" ADD CONSTRAINT "pickups_no_cost_check" CHECK (
  ("no_cost_at" IS NULL) = ("no_cost_reason" IS NULL)
  AND ("no_cost_reason" IS NULL OR char_length(btrim("no_cost_reason")) BETWEEN 3 AND 500)
);
--> statement-breakpoint
CREATE TABLE "pickup_line_receipts" (
  "line_id" uuid NOT NULL REFERENCES "pickup_lines"("id") ON DELETE CASCADE,
  "receipt_id" uuid NOT NULL REFERENCES "receipts"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("line_id", "receipt_id")
);
--> statement-breakpoint
CREATE INDEX "pickup_line_receipts_receipt_idx" ON "pickup_line_receipts" ("receipt_id");
--> statement-breakpoint
-- BACKFILL-MEMORY-BEGIN
-- Every prixod already linked to a stop answers the lines of that stop its
-- owner names — by the ORDERED rule `ownerLinesOf` states (pickups/service):
-- a marking the stop has a MARKING line for names those lines; otherwise the
-- prixod's client names its client lines. Never a union: a prixod received
-- as «MARK» and later claimed keeps the marking (#683), and answering the
-- claimant's own lines too would close trips on cargo still on the road.
-- History is read as the old screen read it (an owner's linked prixod
-- received that owner's lines), minus that union. Voided prixods are
-- remembered too: their rows are history, and «answered» asks for a LIVE one.
INSERT INTO "pickup_line_receipts" ("line_id", "receipt_id", "created_at")
SELECT pl."id", r."id", coalesce(r."confirmed_at", r."created_at")
  FROM "receipts" r
  JOIN "pickup_lines" pl ON pl."stop_id" = r."pickup_stop_id"
 WHERE r."pickup_stop_id" IS NOT NULL
   AND CASE WHEN EXISTS (SELECT 1 FROM "pickup_lines" ml
                          WHERE ml."stop_id" = pl."stop_id" AND ml."client_id" IS NULL
                            AND btrim(coalesce(ml."marking", '')) <> ''
                            AND lower(btrim(ml."marking")) = lower(btrim(r."unclaimed_marking")))
            THEN pl."client_id" IS NULL
                 AND lower(btrim(coalesce(pl."marking", ''))) = lower(btrim(r."unclaimed_marking"))
            ELSE pl."client_id" IS NOT NULL AND pl."client_id" = r."client_id"
       END
ON CONFLICT DO NOTHING;
-- BACKFILL-MEMORY-END
--> statement-breakpoint
-- BACKFILL-PAIR-BEGIN
-- The one unambiguous mismatch history holds (probe S4): a factory line
-- written as a MARKING and its cargo received under the CLIENT code (or the
-- reverse). The owners never match, so the trip read «not received» for
-- ever — the owner's «oldin qabul qilgan reyslarim yana chiqib qolyabti».
-- Paired only when nothing else is possible: the stop's unanswered lines
-- belong to ONE owner, exactly ONE live prixod linked to that stop answers
-- nothing, and the two are of opposite kinds (a client's prixod for marking
-- lines, an unclaimed one for a client's lines). Any other leftover stays
-- open for the logist and is listed by scripts/zavod-tekshir.ts.
WITH "open_lines" AS (
  SELECT pl."id", pl."stop_id", pl."client_id",
         coalesce(pl."client_id"::text, 'm:' || lower(btrim(coalesce(pl."marking", '')))) AS "owner"
    FROM "pickup_lines" pl
   WHERE NOT EXISTS (SELECT 1 FROM "pickup_line_receipts" plr
                       JOIN "receipts" r ON r."id" = plr."receipt_id" AND r."voided_at" IS NULL
                      WHERE plr."line_id" = pl."id")
), "loose" AS (
  SELECT r."pickup_stop_id" AS "stop_id", min(r."id"::text)::uuid AS "receipt_id", count(*) AS "n"
    FROM "receipts" r
   WHERE r."pickup_stop_id" IS NOT NULL AND r."voided_at" IS NULL AND r."status" = 'confirmed'
     AND NOT EXISTS (SELECT 1 FROM "pickup_line_receipts" plr WHERE plr."receipt_id" = r."id")
   GROUP BY r."pickup_stop_id"
), "pairable" AS (
  SELECT l."stop_id", l."receipt_id"
    FROM "loose" l
   WHERE l."n" = 1
     AND (SELECT count(DISTINCT o."owner") FROM "open_lines" o WHERE o."stop_id" = l."stop_id") = 1
)
INSERT INTO "pickup_line_receipts" ("line_id", "receipt_id", "created_at")
SELECT o."id", p."receipt_id", coalesce(r."confirmed_at", r."created_at")
  FROM "pairable" p
  JOIN "open_lines" o ON o."stop_id" = p."stop_id"
  JOIN "receipts" r ON r."id" = p."receipt_id"
 WHERE (o."client_id" IS NULL AND r."client_id" IS NOT NULL)
    OR (o."client_id" IS NOT NULL AND r."client_id" IS NULL)
ON CONFLICT DO NOTHING;
-- BACKFILL-PAIR-END
--> statement-breakpoint
-- BACKFILL-CLOSE-BEGIN
-- A trip whose every line a live prixod answers is closed, dated by the last
-- of those prixods (his 1a, applied to what already happened), with one audit
-- row each so the card's history says when and why (actor NULL = the
-- migration). A trip with no lines, or with a line nobody answered, stays
-- open for the logist to close.
WITH "closing" AS (
  SELECT p."id", p."status" AS "was", p."dest_warehouse_id",
         (SELECT max(coalesce(r."confirmed_at", r."created_at"))
            FROM "pickup_stops" ps
            JOIN "pickup_lines" pl ON pl."stop_id" = ps."id"
            JOIN "pickup_line_receipts" plr ON plr."line_id" = pl."id"
            JOIN "receipts" r ON r."id" = plr."receipt_id" AND r."voided_at" IS NULL
           WHERE ps."pickup_id" = p."id") AS "at"
    FROM "pickups" p
   WHERE p."status" IN ('planned', 'on_road', 'arrived')
     AND EXISTS (
       SELECT 1 FROM "pickup_stops" ps
         JOIN "pickup_lines" pl ON pl."stop_id" = ps."id"
        WHERE ps."pickup_id" = p."id"
     )
     AND NOT EXISTS (
       SELECT 1 FROM "pickup_stops" ps
         JOIN "pickup_lines" pl ON pl."stop_id" = ps."id"
        WHERE ps."pickup_id" = p."id"
          AND NOT EXISTS (
            SELECT 1 FROM "pickup_line_receipts" plr
              JOIN "receipts" r ON r."id" = plr."receipt_id" AND r."voided_at" IS NULL
             WHERE plr."line_id" = pl."id"
          )
     )
), "closed" AS (
  UPDATE "pickups" p
     SET "status" = 'closed',
         "close_kind" = 'auto',
         "closed_at" = c."at",
         "updated_at" = now()
    FROM "closing" c
   WHERE p."id" = c."id"
  RETURNING p."id", c."was", p."dest_warehouse_id"
)
INSERT INTO "audit_log" ("entity_type", "entity_id", "action", "before", "after", "warehouse_id")
SELECT 'pickup', c."id", 'status_change',
       jsonb_build_object('status', c."was"),
       jsonb_build_object('status', 'closed', 'closeKind', 'auto', 'backfill', true),
       c."dest_warehouse_id"
  FROM "closed" c;
-- BACKFILL-CLOSE-END
