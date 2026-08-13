-- Round 98 part 2: the sales analytics page and the lost-reason dictionary.
--
-- `lost_reasons` is the owner's own list of why a job dies («yopilish
-- sababini listdan belgilaydigan qilishimiz kerak»): free text made a
-- breakdown unreadable — «narx», «narx qimmat», «qimmat dedi» are one reason
-- three ways. The stored value on leads/deals STAYS text (the label at the
-- moment of choosing): renaming a reason later must not rewrite what
-- somebody recorded, and history older than the list keeps its words.
CREATE TABLE "lost_reasons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "label" text NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "lost_reasons_label_unique" ON "lost_reasons" (lower("label"));
--> statement-breakpoint
-- When the card was DECIDED (won or lost). `updated_at` cannot answer «what
-- did we close this month» — it moves on every edit — and `created_at` only
-- says when the enquiry arrived. Nullable: open cards carry none.
ALTER TABLE "leads" ADD COLUMN "closed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "closed_at" timestamp with time zone;
--> statement-breakpoint
-- Backfill from updated_at: for a card already sitting in won/lost the last
-- write is usually the closing move. An approximation, stated — the honest
-- stamp starts with the first move after this deploys.
UPDATE "leads" SET "closed_at" = "updated_at"
  WHERE "stage_id" IN (SELECT "id" FROM "lead_stages" WHERE "kind" IN ('won','lost'));
--> statement-breakpoint
UPDATE "deals" SET "closed_at" = "updated_at"
  WHERE "stage_id" IN (SELECT "id" FROM "deal_stages" WHERE "kind" IN ('won','lost'));
--> statement-breakpoint
CREATE INDEX "leads_closed_idx" ON "leads" ("closed_at");
--> statement-breakpoint
CREATE INDEX "deals_closed_idx" ON "deals" ("closed_at");
