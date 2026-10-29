-- Yo'ldagi yuk (the owner, 2026-10-27: «horgos planda yoldagi yuklarni ham qoshish degan check bolsin shuni
-- bosganda yoldagi yuklar ham tanlash imkoniyati bolsin», answers 1a 2a 3a 4a 5a; docs/YOLDAGI-YUK.md).
--
-- A plan line may promise cartons still on a truck bound for the plan's origin. Two SIDE tables and never a
-- column on load_plan_lines: the approval, the plan view and the agent sheet read those lines whole-row, and a
-- column a server one migration behind does not have would answer all three 42703 (#1381). No row = no road
-- part, which is every line that exists today; nothing is backfilled.
--
-- plan_line_road: the road part of a line (frozen at submit, the promise's ceiling), what is still OWED onto
--   the truck (0 until the approval — a pending plan reserves nothing, on the shelf or on the road), and what
--   the truck's loading ended WITHOUT (missed — kept, never erased, so the count door does not ask for it again
--   after «yuklash tugadi»). One writer: wms/planning/road.ts.
-- plan_road_claims: which carton each claim reserved, and off which truck it landed (NULL = taken from the
--   shelf at loading). The give-back's arrival notice and the plan view read it.
--
-- gsr_ai_reader (0080, allowlist default-deny) is granted NOTHING on these tables (stated).
-- Both CASCADE with their line: a road part means nothing once its line is gone. A claim's carton and truck
-- are plain FKs — a carton is never deleted, and the claim names the truck only to re-announce its cargo.
CREATE TABLE "plan_line_road" (
  "line_id" uuid PRIMARY KEY REFERENCES "load_plan_lines"("id") ON DELETE CASCADE,
  "road_box_count" integer NOT NULL,
  "road_owed" integer NOT NULL DEFAULT 0,
  "road_missed" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "plan_line_road_count_check" CHECK (
    "road_box_count" > 0 AND "road_owed" >= 0 AND "road_missed" >= 0
    AND "road_owed" + "road_missed" <= "road_box_count"
  )
);

-- «Which lines still owe» — the landing hook and the loading screen ask it; almost every row is 0.
CREATE INDEX "plan_line_road_owed_idx" ON "plan_line_road" ("line_id") WHERE "road_owed" > 0;

CREATE TABLE "plan_road_claims" (
  "line_id" uuid NOT NULL REFERENCES "load_plan_lines"("id") ON DELETE CASCADE,
  "box_id" uuid NOT NULL REFERENCES "boxes"("id"),
  "inbound_batch_id" uuid REFERENCES "batches"("id"),
  "claimed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("line_id", "box_id")
);

CREATE INDEX "plan_road_claims_box_idx" ON "plan_road_claims" ("box_id");
