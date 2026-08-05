-- Round 67: the sentences a manager types twenty times a day.
--
-- The owner's answer to batch 5's question was «shared AND personal», so the
-- ownership column follows `list_views` exactly: user_id NULL means the whole
-- company can use it and only an admin may write it; otherwise it belongs to
-- that person and nobody else sees it.
--
-- `body` holds `{ism}` and `{kod}` verbatim. The placeholders are filled where
-- the CLIENT is known — on the server, at the moment the composer is rendered
-- — so the stored text stays a template and the browser never has to be told
-- who the customer is in order to write a greeting.
CREATE TABLE reply_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The composer's read: everybody's shared ones plus my own, in order. A
-- partial index on the shared half because that half is read on every thread.
CREATE INDEX reply_templates_owner_idx ON reply_templates (user_id, sort_order);
CREATE INDEX reply_templates_shared_idx ON reply_templates (sort_order) WHERE user_id IS NULL;
