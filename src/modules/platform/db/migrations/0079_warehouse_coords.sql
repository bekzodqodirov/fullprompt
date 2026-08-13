-- Round 100 (owner's 9B): a warehouse's coordinates become the owner's data.
--
-- The map has drawn warehouses from a hard-coded dictionary keyed by CODE
-- since it shipped, so «skladlarni adresini togri qoyishimiz kerak» had no
-- screen to do it on. Nullable and additive: NULL means «use the built-in
-- point», which is what every existing row honestly is — the dictionary
-- stays as the fallback, so the deploy changes nothing visible until he
-- types a coordinate.
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS lat numeric(9, 6);
--> statement-breakpoint
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS lon numeric(9, 6);
--> statement-breakpoint
ALTER TABLE warehouses ADD CONSTRAINT warehouses_lat_check CHECK (lat IS NULL OR lat BETWEEN -90 AND 90);
--> statement-breakpoint
ALTER TABLE warehouses ADD CONSTRAINT warehouses_lon_check CHECK (lon IS NULL OR lon BETWEEN -180 AND 180);
