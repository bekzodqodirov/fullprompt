ALTER TABLE "receipt_lots" ADD COLUMN "pieces_count" integer;--> statement-breakpoint
ALTER TABLE "receipt_lots" ADD COLUMN "packaging_type" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "unclaimed_marking" text;