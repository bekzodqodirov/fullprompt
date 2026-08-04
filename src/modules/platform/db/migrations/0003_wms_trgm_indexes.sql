-- Custom SQL migration file, put your code below! --

-- Trigram indexes for global search (spec §12).
CREATE INDEX IF NOT EXISTS boxes_short_code_trgm_idx ON boxes USING gin (short_code gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS receipts_number_trgm_idx ON receipts USING gin (number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS product_dictionary_zh_trgm_idx ON product_dictionary USING gin (zh gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS product_dictionary_ru_trgm_idx ON product_dictionary USING gin (ru gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS receipt_lots_zh_trgm_idx ON receipt_lots USING gin (product_name_zh gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS receipt_lots_ru_trgm_idx ON receipt_lots USING gin (product_name_ru gin_trgm_ops);
