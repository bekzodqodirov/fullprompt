-- Warehouse scoping becomes a property OF THE ROLE, not of two names
-- compiled into the app. Until now `isWarehouseScoped` consulted a
-- hard-coded array, so a role invented on /admin/roles was born UNSCOPED —
-- hand it receiving permissions and its holder saw every warehouse in the
-- company, silently, in the permissive direction (the same failure class
-- the scope.ts helper exists to prevent).
ALTER TABLE roles ADD COLUMN IF NOT EXISTS warehouse_scoped boolean NOT NULL DEFAULT false;

-- Backfill for a LIVE database. On a fresh one this UPDATE meets no rows —
-- the seed inserts the shipped roles with the flag already set.
UPDATE roles SET warehouse_scoped = true
  WHERE code IN ('warehouse_manager', 'warehouse_operator');
