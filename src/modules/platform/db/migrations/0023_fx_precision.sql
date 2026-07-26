-- Exchange rates need more decimals than a "normal" currency.
--
-- The column was numeric(18,8), which is plenty for 1 CNY = 0.1389 USD but
-- not for the som: 1/12345 is 0.000081004459, and eight decimals rounds that
-- to 0.000081, which reads back as 12 346 so'm per dollar. An off-by-one in
-- a rate the owner typed himself looks like a bug — and on a large invoice
-- it is real money. Twelve decimals holds every rate this company uses.
ALTER TABLE fx_rates ALTER COLUMN rate_to_usd TYPE numeric(24, 12);
--> statement-breakpoint
ALTER TABLE cost_entries ALTER COLUMN fx_rate_used TYPE numeric(24, 12);
--> statement-breakpoint
ALTER TABLE client_transactions ALTER COLUMN rate_to_usd TYPE numeric(24, 12);
--> statement-breakpoint
ALTER TABLE expenses ALTER COLUMN rate_to_usd TYPE numeric(24, 12);
