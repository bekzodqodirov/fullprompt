-- «1 haftalik tarixi bilan tushsin»: when a manager connects, the listener
-- pulls the last week of their CLIENT conversations once. The stamp says the
-- pull is done; NULL (and saveAccount resets it to NULL on every connect)
-- means the next listener start owes one.
ALTER TABLE tg_accounts
  ADD COLUMN IF NOT EXISTS history_backfilled_at timestamptz;
