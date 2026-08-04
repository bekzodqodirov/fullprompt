CREATE TABLE "box_movements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "box_movements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"box_id" uuid NOT NULL,
	"from_warehouse_id" uuid,
	"to_warehouse_id" uuid,
	"from_status" text,
	"to_status" text NOT NULL,
	"cause" text NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "boxes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lot_id" uuid NOT NULL,
	"short_code" text NOT NULL,
	"seq_in_lot" integer NOT NULL,
	"status" text DEFAULT 'in_stock' NOT NULL,
	"current_warehouse_id" uuid,
	"current_batch_id" uuid,
	"crate_id" uuid,
	"label_printed_at" timestamp with time zone,
	"damaged" boolean DEFAULT false NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boxes_short_code_unique" UNIQUE("short_code"),
	CONSTRAINT "boxes_status_check" CHECK ("boxes"."status" IN ('in_stock', 'planned', 'loading', 'in_transit', 'ready_for_pickup', 'issued', 'lost', 'void'))
);
--> statement-breakpoint
CREATE TABLE "cost_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"receipt_id" uuid,
	"batch_id" uuid,
	"cost_type_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"cost_date" date NOT NULL,
	"allocation_basis" text DEFAULT 'weight' NOT NULL,
	"client_id" uuid,
	"note" text,
	"entered_by" uuid NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_entries_scope_check" CHECK ("cost_entries"."scope" IN ('receipt', 'batch')),
	CONSTRAINT "cost_entries_scope_target_check" CHECK (("cost_entries"."scope" = 'receipt' AND "cost_entries"."receipt_id" IS NOT NULL) OR ("cost_entries"."scope" = 'batch' AND "cost_entries"."batch_id" IS NOT NULL)),
	CONSTRAINT "cost_entries_amount_check" CHECK ("cost_entries"."amount" > 0),
	CONSTRAINT "cost_entries_basis_check" CHECK ("cost_entries"."allocation_basis" IN ('weight', 'volume', 'chargeable', 'boxes', 'direct_to_client'))
);
--> statement-breakpoint
CREATE TABLE "cost_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_types_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "counters" (
	"kind" text NOT NULL,
	"scope_key" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "counters_kind_scope_key_pk" PRIMARY KEY("kind","scope_key")
);
--> statement-breakpoint
CREATE TABLE "product_dictionary" (
	"id" uuid PRIMARY KEY NOT NULL,
	"zh" text NOT NULL,
	"ru" text,
	"uz" text,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_dictionary_zh_unique" UNIQUE("zh"),
	CONSTRAINT "product_dictionary_source_check" CHECK ("product_dictionary"."source" IN ('manual', 'api', 'import'))
);
--> statement-breakpoint
CREATE TABLE "receipt_lots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"receipt_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"letter" text,
	"cycle_no" integer,
	"product_name_zh" text NOT NULL,
	"product_name_ru" text,
	"box_count" integer NOT NULL,
	"dims_mode" text DEFAULT 'uniform' NOT NULL,
	"box_length_cm" integer,
	"box_width_cm" integer,
	"box_height_cm" integer,
	"box_weight_kg" numeric(12, 3),
	"total_weight_kg" numeric(12, 3) NOT NULL,
	"total_volume_m3" numeric(12, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_lots_dims_mode_check" CHECK ("receipt_lots"."dims_mode" IN ('uniform', 'mixed')),
	CONSTRAINT "receipt_lots_box_count_check" CHECK ("receipt_lots"."box_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text,
	"warehouse_id" uuid NOT NULL,
	"client_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_note" text,
	"created_by" uuid NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"client_event_uuid" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_number_unique" UNIQUE("number"),
	CONSTRAINT "receipts_client_event_uuid_unique" UNIQUE("client_event_uuid"),
	CONSTRAINT "receipts_status_check" CHECK ("receipts"."status" IN ('draft', 'confirmed', 'voided')),
	CONSTRAINT "receipts_void_consistency" CHECK (("receipts"."voided_at" IS NULL) = ("receipts"."void_reason" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "box_movements" ADD CONSTRAINT "box_movements_box_id_boxes_id_fk" FOREIGN KEY ("box_id") REFERENCES "public"."boxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "box_movements" ADD CONSTRAINT "box_movements_from_warehouse_id_warehouses_id_fk" FOREIGN KEY ("from_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "box_movements" ADD CONSTRAINT "box_movements_to_warehouse_id_warehouses_id_fk" FOREIGN KEY ("to_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "box_movements" ADD CONSTRAINT "box_movements_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_lot_id_receipt_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."receipt_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_current_warehouse_id_warehouses_id_fk" FOREIGN KEY ("current_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_cost_type_id_cost_types_id_fk" FOREIGN KEY ("cost_type_id") REFERENCES "public"."cost_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_lots" ADD CONSTRAINT "receipt_lots_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "box_movements_box_idx" ON "box_movements" USING btree ("box_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "boxes_lot_seq_unique" ON "boxes" USING btree ("lot_id","seq_in_lot");--> statement-breakpoint
CREATE INDEX "boxes_wh_status_idx" ON "boxes" USING btree ("current_warehouse_id","status");--> statement-breakpoint
CREATE INDEX "boxes_lot_idx" ON "boxes" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "cost_entries_receipt_idx" ON "cost_entries" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "cost_entries_batch_idx" ON "cost_entries" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_lots_receipt_seq_unique" ON "receipt_lots" USING btree ("receipt_id","seq");--> statement-breakpoint
CREATE INDEX "receipt_lots_letter_idx" ON "receipt_lots" USING btree ("letter");--> statement-breakpoint
CREATE INDEX "receipts_wh_received_idx" ON "receipts" USING btree ("warehouse_id","received_at");--> statement-breakpoint
CREATE INDEX "receipts_client_idx" ON "receipts" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "receipts_unclaimed_idx" ON "receipts" USING btree ("warehouse_id","received_at") WHERE "receipts"."client_id" IS NULL AND "receipts"."status" = 'confirmed';