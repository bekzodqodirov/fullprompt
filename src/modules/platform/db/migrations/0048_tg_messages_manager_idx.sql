-- Round 20 scoped every conversation read to the viewer's own account:
-- WHERE manager_user_id = X now leads every list/thread/count query, but the
-- only index led with client_id — so the scoped DISTINCT ON walk degraded to
-- a filter over the whole table as history grows (5k+ rows on the owner's
-- account alone, and every newly connected manager adds theirs). This index
-- serves the scoped shape directly; the old (client_id, sent_at) index stays
-- for the supervision view's unscoped walk.
CREATE INDEX IF NOT EXISTS tg_messages_manager_idx
  ON tg_messages (manager_user_id, client_id, sent_at);
