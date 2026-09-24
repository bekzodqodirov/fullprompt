-- The owner's answers of 2026-09-24 on money (R6a and the kassa package
-- M1a-M4a). Additive: a new ledger kind and new nullable columns; nothing
-- existing changes meaning.

-- R6a: money handed BACK to a client from a kassa. Before this the only ways
-- to book it were a 'charge' (the P&L read it as REVENUE, no kassa moved) or
-- an expense (opex, and the client's credit stood untouched) — both wrong in
-- a report. A refund raises the client's balance like a charge, lowers a
-- kassa like an expense, and is neither revenue nor opex.
ALTER TABLE client_transactions DROP CONSTRAINT client_transactions_type_check;
ALTER TABLE client_transactions ADD CONSTRAINT client_transactions_type_check
  CHECK (type IN ('charge', 'payment', 'refund'));
-- Money that left names the box it left from, and a truck is never refunded.
ALTER TABLE client_transactions ADD CONSTRAINT client_transactions_refund_check
  CHECK (type <> 'refund' OR (account_id IS NOT NULL AND partner_id IS NULL AND batch_id IS NULL));

-- The AI's one money view restates clientBalanceUsd(); a refund RAISES the
-- balance, and `ELSE -amount_usd` would have read it as a payment. Grants
-- survive CREATE OR REPLACE.
CREATE OR REPLACE VIEW v_client_balance_usd AS
SELECT client_id,
       round(coalesce(sum(CASE WHEN type = 'payment' THEN -amount_usd ELSE amount_usd END), 0), 2) AS balance_usd
FROM client_transactions
WHERE voided_at IS NULL
GROUP BY client_id;
