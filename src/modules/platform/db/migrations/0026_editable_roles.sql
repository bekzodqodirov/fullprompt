-- Who can do what stops being a deploy.
--
-- ROLE_MATRIX in catalog.ts was the only writer of grants, through seed.ts,
-- insert-only with ON CONFLICT DO NOTHING: an owner could not add a
-- permission to a role, could not take one away, and could not invent a role.
--
-- The handover rule is `grants_customised`: the seed bootstraps a role's
-- grants ONCE, and the moment the owner edits that role the seed stops
-- touching it. Without this, the next deploy would silently restore every
-- permission the owner had just removed — the failure mode that makes people
-- stop trusting a permissions screen.
ALTER TABLE roles ADD COLUMN description text;
--> statement-breakpoint
ALTER TABLE roles ADD COLUMN grants_customised boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Where a grant came from, so an audit can tell "the system shipped this"
-- from "someone chose this".
ALTER TABLE role_permissions ADD COLUMN source text NOT NULL DEFAULT 'seed';
--> statement-breakpoint
ALTER TABLE role_permissions
  ADD CONSTRAINT role_permissions_source_check CHECK (source IN ('seed', 'admin'));
--> statement-breakpoint

-- Roles the owner creates are not system roles and may be deleted; the nine
-- that ship with the app may not.
UPDATE roles SET is_system = true WHERE is_system IS NULL;
