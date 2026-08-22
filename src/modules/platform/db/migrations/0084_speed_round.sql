-- Round 108 (the third speed round): two partial indexes the notifications
-- table earned the day it reached six figures, and the edit stamp the chat
-- pulse needs.
--
-- `tg_messages.edited_at` — nullable, additive: NULL reads «never edited»,
-- so every stored row keeps its meaning. `applyEdit` has always rewritten
-- `body` in place with no trace; the pulse token watches maxima and counts,
-- and an UPDATE that moves neither would leave a corrected «100 kub»
-- reading «10 kub» on screen for ever (the design review's finding).
ALTER TABLE tg_messages ADD COLUMN IF NOT EXISTS edited_at timestamptz;

--
-- (a) `reclaimStaleTelegram` runs at least once a minute and its predicate
--     (channel + status='sending' + claimed_at) matched NO index — measured
--     on a 680k-row copy: a 119 ms sequential UPDATE-scan, every minute,
--     all day, on the same disk every screen reads. The index is tiny by
--     construction: only in-flight rows live in it.
--
-- (b) `notificationProblemCount` (the admin dashboard's «yuborilmagan»
--     cell) OR-s failed / pending-with-error / stuck-sending over a 7-day
--     window and could use only a seq scan — measured 67 ms → 0.04 ms with
--     the partial below. Problem rows are near-zero at rest, so the index
--     stays a few kilobytes however large the table grows.
CREATE INDEX IF NOT EXISTS notifications_sending_idx
  ON notifications (claimed_at)
  WHERE channel = 'telegram' AND status = 'sending';

CREATE INDEX IF NOT EXISTS notifications_problem_idx
  ON notifications (created_at)
  WHERE channel = 'telegram'
    AND (status = 'failed'
      OR (status = 'pending' AND error IS NOT NULL)
      OR status = 'sending');
