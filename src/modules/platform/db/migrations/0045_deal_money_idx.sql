-- Per-deal money: dealCharged/deferredBalanceUsd/dealProfit all filter
-- client_transactions by deal_id, which until now had no index — the batch
-- side has carried client_transactions_batch_idx since Phase 2.4 for exactly
-- the same query shape.
CREATE INDEX IF NOT EXISTS client_transactions_deal_idx
  ON client_transactions (deal_id)
  WHERE deal_id IS NOT NULL;
