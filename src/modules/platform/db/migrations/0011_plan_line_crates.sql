-- A wooden crate is planned as ONE place (owner's request): plan lines may
-- reference the crate whose boxes they cover, so approval reserves exactly
-- those boxes and the editor can show/select the crate as a single unit.
ALTER TABLE "load_plan_lines" ADD COLUMN "crate_id" uuid REFERENCES "crates"("id");--> statement-breakpoint
DROP INDEX IF EXISTS "load_plan_lines_version_lot_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "load_plan_lines_version_lot_unique" ON "load_plan_lines" ("version_id","lot_id","crate_id");--> statement-breakpoint
CREATE INDEX "load_plan_lines_crate_idx" ON "load_plan_lines" ("crate_id");
