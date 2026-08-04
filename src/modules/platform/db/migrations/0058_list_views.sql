-- Round 57: a saved view is a NAMED QUERY STRING for one screen, nothing more.
-- Every list here filters and sorts through its own URL params already, so a
-- view needs no query builder of its own: it stores what was in the address
-- bar and applying it is a navigation. That is why `query` is text and not a
-- structured column — a screen that grows a new filter tomorrow stores it
-- without a migration.
--
-- user_id NULL means the view is published to the whole company (admin only,
-- the owner's answer 2026-08-04); otherwise the view belongs to that person.
-- is_default is personal by construction: a company-wide default would decide
-- what every colleague sees on entry, which is a different and larger power.
CREATE TABLE list_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  screen text NOT NULL,
  name text NOT NULL,
  query text NOT NULL DEFAULT '',
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  is_default boolean NOT NULL DEFAULT false,
  pinned boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT list_views_default_check CHECK (is_default = false OR user_id IS NOT NULL)
);
--> statement-breakpoint
-- The screen's own read: my views plus the published ones, on every list load.
CREATE INDEX list_views_screen_idx ON list_views (screen, user_id);
--> statement-breakpoint
-- One default per person per screen — enforced here rather than in the service,
-- because two defaults would make "which list do I get" depend on row order.
CREATE UNIQUE INDEX list_views_default_unique
  ON list_views (user_id, screen) WHERE is_default;
--> statement-breakpoint
-- A name is how the view is chosen, so a duplicate is a trap rather than a
-- convenience. Own names are unique to their owner; published names to all.
CREATE UNIQUE INDEX list_views_own_name_unique
  ON list_views (user_id, screen, lower(name)) WHERE user_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX list_views_public_name_unique
  ON list_views (screen, lower(name)) WHERE user_id IS NULL;
