CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"origin_warehouse_id" uuid NOT NULL,
	"dest_warehouse_id" uuid NOT NULL,
	"type" text DEFAULT 'transfer' NOT NULL,
	"status" text DEFAULT 'forming' NOT NULL,
	"vehicle_plate" text,
	"driver_name" text,
	"driver_phone" text,
	"departed_at" timestamp with time zone,
	"arrived_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"sent_to_agent_at" date,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batches_code_unique" UNIQUE("code"),
	CONSTRAINT "batches_type_check" CHECK ("batches"."type" IN ('transfer', 'export', 'distribution')),
	CONSTRAINT "batches_status_check" CHECK ("batches"."status" IN ('forming', 'loading', 'in_transit', 'arrived', 'unloaded', 'closed', 'cancelled')),
	CONSTRAINT "batches_route_check" CHECK ("batches"."origin_warehouse_id" <> "batches"."dest_warehouse_id")
);
--> statement-breakpoint
CREATE TABLE "load_plan_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"planned_box_count" integer NOT NULL,
	"planned_kg" numeric(12, 3) NOT NULL,
	"planned_m3" numeric(12, 4) NOT NULL,
	CONSTRAINT "load_plan_lines_count_check" CHECK ("load_plan_lines"."planned_box_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "load_plan_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_by" uuid NOT NULL,
	"total_boxes" integer NOT NULL,
	"total_kg" numeric(12, 3) NOT NULL,
	"total_m3" numeric(12, 4) NOT NULL,
	"agent_verdict" text,
	"agent_comment" text,
	"verdict_recorded_by" uuid,
	"verdict_recorded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "load_plan_versions_verdict_check" CHECK ("load_plan_versions"."agent_verdict" IS NULL OR "load_plan_versions"."agent_verdict" IN ('approved', 'changes_requested'))
);
--> statement-breakpoint
CREATE TABLE "load_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_warehouse_id" uuid NOT NULL,
	"dest_warehouse_id" uuid NOT NULL,
	"batch_id" uuid,
	"truck_preset_id" uuid,
	"max_kg" numeric(12, 3),
	"max_m3" numeric(12, 4),
	"target_date" date,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version_no" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "load_plans_batch_id_unique" UNIQUE("batch_id"),
	CONSTRAINT "load_plans_status_check" CHECK ("load_plans"."status" IN ('draft', 'pending_agent', 'changes_requested', 'approved', 'loading', 'completed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "scan_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_event_uuid" uuid NOT NULL,
	"box_id" uuid NOT NULL,
	"crate_id" uuid,
	"batch_id" uuid,
	"handover_id" uuid,
	"type" text NOT NULL,
	"method" text NOT NULL,
	"manual_reason" text,
	"added_on_spot" boolean DEFAULT false NOT NULL,
	"scanned_by" uuid NOT NULL,
	"scanned_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scan_events_client_event_uuid_unique" UNIQUE("client_event_uuid"),
	CONSTRAINT "scan_events_type_check" CHECK ("scan_events"."type" IN ('load', 'unload', 'issue')),
	CONSTRAINT "scan_events_method_check" CHECK ("scan_events"."method" IN ('qr', 'manual', 'crate')),
	CONSTRAINT "scan_events_manual_reason_check" CHECK ("scan_events"."method" <> 'manual' OR "scan_events"."manual_reason" IS NOT NULL),
	CONSTRAINT "scan_events_target_check" CHECK (("scan_events"."type" = 'issue') = ("scan_events"."handover_id" IS NOT NULL) AND ("scan_events"."type" <> 'issue') = ("scan_events"."batch_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "truck_presets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"max_kg" numeric(12, 3) NOT NULL,
	"max_m3" numeric(12, 4) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "truck_presets_max_kg_check" CHECK ("truck_presets"."max_kg" > 0),
	CONSTRAINT "truck_presets_max_m3_check" CHECK ("truck_presets"."max_m3" > 0)
);
--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_origin_warehouse_id_warehouses_id_fk" FOREIGN KEY ("origin_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_dest_warehouse_id_warehouses_id_fk" FOREIGN KEY ("dest_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_plan_lines" ADD CONSTRAINT "load_plan_lines_version_id_load_plan_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."load_plan_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_plan_lines" ADD CONSTRAINT "load_plan_lines_lot_id_receipt_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."receipt_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_plan_versions" ADD CONSTRAINT "load_plan_versions_plan_id_load_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."load_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_plan_versions" ADD CONSTRAINT "load_plan_versions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_plan_versions" ADD CONSTRAINT "load_plan_versions_verdict_recorded_by_users_id_fk" FOREIGN KEY ("verdict_recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_plans" ADD CONSTRAINT "load_plans_origin_warehouse_id_warehouses_id_fk" FOREIGN KEY ("origin_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_plans" ADD CONSTRAINT "load_plans_dest_warehouse_id_warehouses_id_fk" FOREIGN KEY ("dest_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_plans" ADD CONSTRAINT "load_plans_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_plans" ADD CONSTRAINT "load_plans_truck_preset_id_truck_presets_id_fk" FOREIGN KEY ("truck_preset_id") REFERENCES "public"."truck_presets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_plans" ADD CONSTRAINT "load_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_box_id_boxes_id_fk" FOREIGN KEY ("box_id") REFERENCES "public"."boxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_crate_id_crates_id_fk" FOREIGN KEY ("crate_id") REFERENCES "public"."crates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_handover_id_handovers_id_fk" FOREIGN KEY ("handover_id") REFERENCES "public"."handovers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_scanned_by_users_id_fk" FOREIGN KEY ("scanned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batches_origin_status_idx" ON "batches" USING btree ("origin_warehouse_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "load_plan_lines_version_lot_unique" ON "load_plan_lines" USING btree ("version_id","lot_id");--> statement-breakpoint
CREATE INDEX "load_plan_lines_lot_idx" ON "load_plan_lines" USING btree ("lot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "load_plan_versions_plan_no_unique" ON "load_plan_versions" USING btree ("plan_id","version_no");--> statement-breakpoint
CREATE INDEX "load_plans_origin_idx" ON "load_plans" USING btree ("origin_warehouse_id","status");--> statement-breakpoint
CREATE INDEX "scan_events_batch_type_idx" ON "scan_events" USING btree ("batch_id","type");--> statement-breakpoint
CREATE INDEX "scan_events_box_idx" ON "scan_events" USING btree ("box_id");--> statement-breakpoint
CREATE INDEX "scan_events_scanner_idx" ON "scan_events" USING btree ("scanned_by","scanned_at");--> statement-breakpoint
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_current_batch_id_batches_id_fk" FOREIGN KEY ("current_batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;