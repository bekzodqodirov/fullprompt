-- Round 26 (owner's item 6): a deal follows its cargo through the funnel.
-- A stage may name ONE cargo state; when the deal's linked cargo reaches it,
-- the deal moves to that stage by itself — forward only, open deals only.
-- Nullable and additive: a stage without a trigger behaves exactly as before,
-- and the seeded funnel ships with no triggers until the owner sets his own.
ALTER TABLE deal_stages ADD COLUMN cargo_trigger text;
--> statement-breakpoint
ALTER TABLE deal_stages ADD CONSTRAINT deal_stages_cargo_trigger_check
  CHECK (cargo_trigger IS NULL OR cargo_trigger IN ('received', 'departed', 'arrived', 'ready', 'handed'));
