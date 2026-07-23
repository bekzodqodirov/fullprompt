ALTER TABLE "receipt_lots" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "receipt_lots" DROP COLUMN "pieces_count";--> statement-breakpoint
ALTER TABLE "receipt_lots" DROP COLUMN "packaging_type";