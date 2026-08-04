-- Missing-in-transit / flag lookups (@> on jsonb) get a GIN index.
CREATE INDEX IF NOT EXISTS "boxes_flags_gin" ON "boxes" USING gin ("flags" jsonb_path_ops);
