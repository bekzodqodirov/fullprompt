-- Custom SQL migration file, put your code below! --

-- Extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- Audit log immutability (spec 4.3): append-only at the database level.
-- Belt: revoke UPDATE/DELETE from everyone (a dedicated non-superuser app
-- role is created at deploy time; grants below cover it).
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM PUBLIC;
--> statement-breakpoint

-- Suspenders: a trigger that rejects UPDATE/DELETE even for privileged
-- connections (dev runs as superuser, which ignores grants).
CREATE OR REPLACE FUNCTION audit_log_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
--> statement-breakpoint

-- Trigram indexes for global search (spec §12) on M0 registries.
CREATE INDEX IF NOT EXISTS clients_code_trgm_idx ON clients USING gin (client_code gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS clients_name_trgm_idx ON clients USING gin (name gin_trgm_ops);
