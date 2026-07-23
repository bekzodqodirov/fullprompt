CREATE TABLE "crates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"kind" text DEFAULT 'yashik' NOT NULL,
	"logist_approved" boolean DEFAULT false NOT NULL,
	"note" text,
	"length_cm" integer,
	"width_cm" integer,
	"height_cm" integer,
	"weight_kg" numeric(12, 3),
	"created_by" uuid NOT NULL,
	"dissolved_at" timestamp with time zone,
	"dissolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crates_code_unique" UNIQUE("code"),
	CONSTRAINT "crates_status_check" CHECK ("crates"."status" IN ('active', 'dissolved')),
	CONSTRAINT "crates_kind_check" CHECK ("crates"."kind" IN ('yashik', 'karkas')),
	CONSTRAINT "crates_dissolved_consistency" CHECK (("crates"."dissolved_at" IS NULL) = ("crates"."dissolved_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "handovers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"receipt_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"kind" text DEFAULT 'returned_to_sender' NOT NULL,
	"person_name" text NOT NULL,
	"person_phone" text NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handovers_kind_check" CHECK ("handovers"."kind" IN ('returned_to_sender', 'issued_to_client'))
);
--> statement-breakpoint
ALTER TABLE "crates" ADD CONSTRAINT "crates_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crates" ADD CONSTRAINT "crates_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crates" ADD CONSTRAINT "crates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crates" ADD CONSTRAINT "crates_dissolved_by_users_id_fk" FOREIGN KEY ("dissolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crates_wh_status_idx" ON "crates" USING btree ("warehouse_id","status");--> statement-breakpoint
CREATE INDEX "crates_client_idx" ON "crates" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "handovers_receipt_idx" ON "handovers" USING btree ("receipt_id");--> statement-breakpoint
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_crate_id_crates_id_fk" FOREIGN KEY ("crate_id") REFERENCES "public"."crates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "boxes_crate_idx" ON "boxes" USING btree ("crate_id");