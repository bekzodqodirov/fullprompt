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

-- ---------------------------------------------------------------------------
-- The kassa package (owner 3b + A1c/A2a/A3 + M1a-M4a).
--
-- 3b: a cost «we paid» never said FROM WHICH kassa, so the accountant typed
-- the same money again as an expense with a kassa — the drawer was right, the
-- P&L and the cash flow counted it twice. A cost now names its kassa, in the
-- kassa's own currency (customs typed in USD, paid out of a som account):
ALTER TABLE cost_entries ADD COLUMN account_id uuid REFERENCES money_accounts(id);
ALTER TABLE cost_entries ADD COLUMN account_amount numeric(14, 2);
-- Who paid is ONE of: a counterparty (a debt), a kassa (cash out), or nobody
-- said yet (the accountant's queue). Never two.
ALTER TABLE cost_entries ADD CONSTRAINT cost_entries_payer_check
  CHECK (NOT (partner_id IS NOT NULL AND account_id IS NOT NULL));
ALTER TABLE cost_entries ADD CONSTRAINT cost_entries_account_amount_check
  CHECK ((account_id IS NULL) = (account_amount IS NULL)
         AND (account_amount IS NULL OR (account_amount > 0 AND account_amount <> 'NaN'::numeric)));
-- The duplicate merge's provenance (A3/M4a): the expense this cost replaced.
ALTER TABLE cost_entries ADD COLUMN merged_expense_id uuid REFERENCES expenses(id);
CREATE INDEX cost_entries_account_idx ON cost_entries (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX cost_entries_unplaced_idx ON cost_entries (created_at)
  WHERE voided_at IS NULL AND partner_id IS NULL AND account_id IS NULL;

-- A1c: a staff member is a counterparty of their own — money they paid out
-- of pocket is a debt of ours, an advance is a debt of theirs. The login link
-- is what lets /profile show a person THEIR account (A2a), and what hides
-- staff accounts from everybody but the accountant and the admin (M3a).
ALTER TABLE partners ADD COLUMN user_id uuid REFERENCES users(id);
CREATE UNIQUE INDEX partners_user_uniq ON partners (user_id) WHERE user_id IS NOT NULL;
-- The «Hodim» TYPE is written by the seed and not here: the seed fills the
-- starter types only into an EMPTY table, so a row this migration wrote
-- first would have cost a fresh install transport, customs and the rest.

-- M1a: «o'z pulimdan to'ladim» is said ONLY through the rasxod xabari, and
-- the accountant's «Kiritish» turns it into the debt. Filed from /profile by
-- people who belong to no warehouse, hence the warehouse becomes optional.
ALTER TABLE expense_requests ADD COLUMN paid_by_self boolean NOT NULL DEFAULT false;
ALTER TABLE expense_requests ALTER COLUMN warehouse_id DROP NOT NULL;

-- The queue of costs nobody has said the kassa of starts TODAY: every cost
-- before this deploy has no kassa by construction, and asking the accountant
-- to place years of history would double-debit tills whose opening counts
-- already include it. Older ones stay «kassasi noma'lum» history, merged or
-- left. The accountant can move the date on /admin/settings.
INSERT INTO settings (key, value) VALUES ('cost_kassa_since', to_jsonb((now() AT TIME ZONE 'Asia/Tashkent')::date::text))
  ON CONFLICT (key) DO NOTHING;
