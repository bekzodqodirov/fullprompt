-- The scanning path, measured on the owner's real data (10,920 boxes,
-- 26,180 movements).
--
-- `batchMemberFilter` is the query behind /api/batches/[id]/planned — the
-- loading screen's snapshot, refetched after every scan — and behind the
-- batch board, the truck map, batch pricing and the cost allocator. It asks
-- "is this box on batch X", and the EXISTS half had no index at all: the only
-- index on box_movements is (box_id, created_at), so every call ran a
-- sequential scan of box_movements per candidate box.
--
--   before: 40 ms warm, 380 ms cold, 9.6 s on a cold plan
--   after:  1.2 ms
--
-- Cost of carrying them: two more indexes to maintain on the two hottest
-- tables in the system, and a few MB of disk. box_movements is append-only
-- (nothing ever updates a movement) so the write cost is one index insert per
-- movement row; boxes.current_batch_id changes a handful of times per box in
-- its whole life. Both are far cheaper than the scan they replace.
--
-- Plain CREATE INDEX, not CONCURRENTLY: drizzle wraps all pending migrations
-- in ONE transaction, so CONCURRENTLY is impossible here (CLAUDE.md). That
-- means this takes a brief write lock on both tables — milliseconds at
-- today's row counts, which is exactly why it is worth doing now rather than
-- at 200,000 boxes.
CREATE INDEX IF NOT EXISTS box_movements_ref_idx
  ON box_movements (ref_type, ref_id, cause);

CREATE INDEX IF NOT EXISTS boxes_current_batch_idx
  ON boxes (current_batch_id)
  WHERE current_batch_id IS NOT NULL;
