-- The owner's Q15 (2), 2026-09-25 («15 a yoqolgan yuk a»): money we pay a
-- client for LOST cargo above our own price is a ledger kind of its own. It
-- lowers what the client owes, like a payment, and is taken off that
-- client's and that job's revenue — a price taken back, never an expense
-- (DEALS.md answer 3). It moves no kassa: the cash leaves by the refund
-- («Pul qaytarildi») that follows it. The part within our own price is paid
-- by LOWERING the price (void + re-post of the truck's or the deal's charge),
-- in the same press — that part needs no kind.
--
-- Additive: a new kind, a new nullable column, a CHECK every existing row
-- passes, the AI's view restated. No row changes meaning — nothing is a
-- compensation yet.

ALTER TABLE client_transactions ADD COLUMN receipt_id uuid REFERENCES receipts(id);

-- Restated from the LATEST migration that defines this constraint (0103,
-- which added 'fx_diff' to 0101's list) — never from memory. The unit fence
-- F6 reads the last one and compares it with CLIENT_KINDS.
ALTER TABLE client_transactions DROP CONSTRAINT client_transactions_type_check;
ALTER TABLE client_transactions ADD CONSTRAINT client_transactions_type_check
  CHECK (type IN ('charge', 'payment', 'refund', 'fx_diff', 'compensation'));

-- A compensation names the prixod whose cargo was lost, and why, and nothing
-- that moves money: no kassa, no firm, no truck, no method. Only a
-- compensation names a prixod, so the column has exactly one meaning.
ALTER TABLE client_transactions ADD CONSTRAINT client_transactions_compensation_check
  CHECK ((type = 'compensation') = (receipt_id IS NOT NULL)
         AND (type <> 'compensation' OR (account_id IS NULL AND partner_id IS NULL
              AND batch_id IS NULL AND method IS NULL
              AND length(btrim(coalesce(note, ''))) >= 3)));

CREATE INDEX client_transactions_receipt_idx ON client_transactions (receipt_id)
  WHERE receipt_id IS NOT NULL;

-- The AI's one money view restates the ledger's sign (0101 did the same for
-- the refund). The CREDIT list is the kinds whose balance sign is −1; a
-- signed kind (0103's fx_diff) falls through to ELSE and adds its own sign.
-- Grants survive CREATE OR REPLACE.
CREATE OR REPLACE VIEW v_client_balance_usd AS
SELECT client_id,
       round(coalesce(sum(CASE WHEN type IN ('payment', 'compensation') THEN -amount_usd ELSE amount_usd END), 0), 2) AS balance_usd
FROM client_transactions
WHERE voided_at IS NULL
GROUP BY client_id;
