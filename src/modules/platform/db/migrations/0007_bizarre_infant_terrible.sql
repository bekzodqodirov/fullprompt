ALTER TABLE "cost_entries" DROP CONSTRAINT "cost_entries_scope_check";--> statement-breakpoint
ALTER TABLE "cost_entries" DROP CONSTRAINT "cost_entries_scope_target_check";--> statement-breakpoint
ALTER TABLE "cost_entries" ADD COLUMN "crate_id" uuid;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_crate_id_crates_id_fk" FOREIGN KEY ("crate_id") REFERENCES "public"."crates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_scope_check" CHECK ("cost_entries"."scope" IN ('receipt', 'batch', 'crate'));--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_scope_target_check" CHECK (("cost_entries"."scope" = 'receipt' AND "cost_entries"."receipt_id" IS NOT NULL) OR ("cost_entries"."scope" = 'batch' AND "cost_entries"."batch_id" IS NOT NULL) OR ("cost_entries"."scope" = 'crate' AND "cost_entries"."crate_id" IS NOT NULL));