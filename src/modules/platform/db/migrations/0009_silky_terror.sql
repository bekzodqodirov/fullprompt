ALTER TABLE "handovers" ALTER COLUMN "receipt_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "handovers" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "handovers" ADD COLUMN "debt_ok" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handovers_client_idx" ON "handovers" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_target_check" CHECK (("handovers"."kind" = 'returned_to_sender' AND "handovers"."receipt_id" IS NOT NULL) OR ("handovers"."kind" = 'issued_to_client' AND "handovers"."client_id" IS NOT NULL));