-- M6 costing core: dated manual FX rates, materialized per-box cost
-- allocations (rebuilt by the recompute job), USD conversion columns on
-- cost_entries, and warehouse capacity for the fill indicator.
-- The M0 fx_rates placeholder was pair-based (from/to) and never written to;
-- costing wants one USD-base rate per currency per date — replace it.
DROP TABLE IF EXISTS "fx_rates";--> statement-breakpoint
CREATE TABLE "fx_rates" (
  "id" uuid PRIMARY KEY NOT NULL,
  "currency" varchar(3) NOT NULL REFERENCES "currencies"("code"),
  "rate_to_usd" numeric(18,8) NOT NULL,
  "effective_date" date NOT NULL,
  "entered_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fx_rates_rate_check" CHECK ("rate_to_usd" > 0),
  CONSTRAINT "fx_rates_currency_date_unique" UNIQUE ("currency", "effective_date")
);--> statement-breakpoint
CREATE TABLE "cost_allocations" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "cost_entry_id" uuid NOT NULL REFERENCES "cost_entries"("id") ON DELETE CASCADE,
  "box_id" uuid NOT NULL REFERENCES "boxes"("id"),
  "client_id" uuid REFERENCES "clients"("id"),
  "amount_usd" numeric(14,4) NOT NULL,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cost_allocations_entry_box_unique" UNIQUE ("cost_entry_id", "box_id")
);--> statement-breakpoint
CREATE INDEX "cost_allocations_box_idx" ON "cost_allocations" ("box_id");--> statement-breakpoint
CREATE INDEX "cost_allocations_client_idx" ON "cost_allocations" ("client_id");--> statement-breakpoint
ALTER TABLE "cost_entries" ADD COLUMN "amount_usd" numeric(14,2);--> statement-breakpoint
ALTER TABLE "cost_entries" ADD COLUMN "fx_rate_used" numeric(18,8);--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "capacity_m3" numeric(12,2);
