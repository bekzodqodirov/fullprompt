-- «Tez-tez» (owner, 2026-09-26, answer 2c: «yulduzcha bosilgan va o'zi
-- yig'iladigan»): the pages a person opens most and the ones they starred, at
-- the top of their menu. One row per (person, menu tab).
--
-- `href` is a menu TAB's own link, never the raw URL the person stood on — the
-- visit route re-derives the viewer's visible tabs and refuses anything else,
-- so no id, no query string and no page they may not open can land here.
--
-- `score` decays with a 14-day half-life, computed in SQL at write AND at
-- read time (`score * 0.5 ^ (age / 14 days)`), so a page opened daily last
-- month does not outrank what this week is about. Nothing prunes this table:
-- a row is a few bytes per person per tab and there are ~90 tabs.
CREATE TABLE nav_usage (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  href text NOT NULL,
  starred boolean NOT NULL DEFAULT false,
  -- When it was starred: the stars keep the order they were given in, so the
  -- top of the menu does not reshuffle itself every time a page is opened.
  starred_at timestamptz,
  score double precision NOT NULL DEFAULT 0,
  last_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, href),
  CONSTRAINT nav_usage_href_check CHECK (href LIKE '/%' AND length(href) <= 64),
  CONSTRAINT nav_usage_score_check CHECK (score >= 0 AND score <> 'NaN'::double precision),
  CONSTRAINT nav_usage_starred_check CHECK (starred = (starred_at IS NOT NULL))
);
