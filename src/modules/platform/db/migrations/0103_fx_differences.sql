-- The owner's answers of 2026-09-25 on exchange differences (Q12 A, Q13 A,
-- Q14 A, Q18, and the defaults of Q24 b / Q25 a). Additive: three frozen
-- dollar/rate columns, one system ledger kind on both ledgers, the adjust's
-- kind, and the instant the automatic PARTNER close starts. No existing amount
-- is rewritten; the backfills fill NEW columns only.
--
-- Every CHECK below binds no existing row (drizzle runs every pending
-- migration in ONE transaction, so a refused row here would roll back the
-- whole deploy morning), and the dollar columns are `>= 0`, not `> 0`: a
-- 1-so'm transfer rounds to $0.00.

-- Q13 / U12: what left the kassa, in DOLLARS, and at which rate — the
-- PAYMENT's own figure, frozen when the kassa is named (Q18: «to'lab bergan
-- to'lovlar o'zgarmasligi kerak»). The cost's amount_usd stays the tannarx
-- (the day's table rate); their difference is «Kurs farqi (kassa)». The rate
-- is kept so a payment typed before its day's rate can be FOUND — it is never
-- re-priced, only listed.
ALTER TABLE cost_entries ADD COLUMN account_amount_usd numeric(14, 2);
ALTER TABLE cost_entries ADD COLUMN account_rate_used numeric(24, 12);
ALTER TABLE cost_entries ADD CONSTRAINT cost_entries_account_usd_check
  CHECK ((account_amount_usd IS NULL) = (account_rate_used IS NULL)
     AND (account_amount_usd IS NULL OR account_id IS NOT NULL)
     AND (account_amount_usd IS NULL OR (account_amount_usd >= 0 AND account_amount_usd <> 'NaN'::numeric))
     AND (account_rate_used IS NULL OR (account_rate_used > 0 AND account_rate_used <> 'NaN'::numeric)));

-- Backfill, stated as an approximation (the rate book as it stands today). On
-- his server 0101 arrives in this same deploy, so no cost has a kassa yet and
-- this touches nothing there; it exists for every other database. A merged
-- cost takes the expense's rate (the expense WAS the payment); a same-currency
-- kassa takes the cost's own figure.
WITH till AS (
  SELECT ce.id,
         (ma.currency = ce.currency AND ce.merged_expense_id IS NULL) AS same,
         CASE
           WHEN ce.merged_expense_id IS NOT NULL THEN
             (SELECT e.rate_to_usd FROM expenses e WHERE e.id = ce.merged_expense_id)
           WHEN ma.currency = ce.currency THEN ce.fx_rate_used
           WHEN ma.currency = 'USD' THEN 1
           ELSE coalesce(
             (SELECT fr.rate_to_usd FROM fx_rates fr
               WHERE fr.currency = ma.currency AND fr.effective_date <= ce.cost_date
               ORDER BY fr.effective_date DESC LIMIT 1),
             (SELECT fr.rate_to_usd FROM fx_rates fr
               WHERE fr.currency = ma.currency ORDER BY fr.effective_date ASC LIMIT 1))
         END AS rate
    FROM cost_entries ce JOIN money_accounts ma ON ma.id = ce.account_id
)
UPDATE cost_entries ce
   SET account_rate_used = till.rate,
       account_amount_usd = CASE WHEN till.same THEN ce.amount_usd
                                 ELSE round(ce.account_amount * till.rate, 2) END
  FROM till
 WHERE till.id = ce.id AND till.rate IS NOT NULL
   AND (NOT till.same OR ce.amount_usd IS NOT NULL);

-- U11 (3): the other side of a transfer, in dollars, frozen at entry. NULL
-- when the to-currency has no rate (named beside the P&L and filled once by
-- the nightly sweep — never a refusal: an unrated till must still receive
-- money). Same currency = the from-side figure, so a legacy same-currency typo
-- (before A35) is NOT an exchange difference.
ALTER TABLE account_transfers ADD COLUMN amount_to_usd numeric(14, 2);
ALTER TABLE account_transfers ADD CONSTRAINT account_transfers_amount_to_usd_check
  CHECK (amount_to_usd IS NULL OR (amount_to_usd >= 0 AND amount_to_usd <> 'NaN'::numeric));
UPDATE account_transfers t
   SET amount_to_usd = CASE
     WHEN tf.currency = tt.currency THEN t.amount_usd
     WHEN tt.currency = 'USD' THEN t.amount_to
     ELSE round(t.amount_to * coalesce(
       (SELECT fr.rate_to_usd FROM fx_rates fr
         WHERE fr.currency = tt.currency AND fr.effective_date <= t.transfer_date
         ORDER BY fr.effective_date DESC LIMIT 1),
       (SELECT fr.rate_to_usd FROM fx_rates fr
         WHERE fr.currency = tt.currency ORDER BY fr.effective_date ASC LIMIT 1)), 2)
   END
  FROM money_accounts tf, money_accounts tt
 WHERE tf.id = t.from_account_id AND tt.id = t.to_account_id;

-- Q14: the «kurs farqi» row, on BOTH ledgers. Native amount 0 (the account's
-- own money is already at zero — that is the trigger), a signed amount_usd
-- that closes the dollar residue, and the row that closed the cycle as its
-- anchor. In the cycle's currency when the SYSTEM writes it; in USD when the
-- accountant closes a cross-currency residue by hand (Q24 b) — the currency
-- is what tells the two apart, so the unique index is per (anchor, currency).
-- deal_id stays NULL: the handover deferral no longer counts rows of a closed
-- cycle at all, so the row needs no job.
ALTER TABLE client_transactions DROP CONSTRAINT client_transactions_type_check;
ALTER TABLE client_transactions ADD CONSTRAINT client_transactions_type_check
  CHECK (type IN ('charge', 'payment', 'refund', 'fx_diff'));
ALTER TABLE client_transactions DROP CONSTRAINT client_transactions_amount_check;
ALTER TABLE client_transactions ADD CONSTRAINT client_transactions_amount_check
  CHECK (CASE WHEN type = 'fx_diff' THEN amount = 0 ELSE amount > 0 END);
ALTER TABLE client_transactions ADD COLUMN fx_anchor_id uuid REFERENCES client_transactions(id);
ALTER TABLE client_transactions ADD CONSTRAINT client_transactions_fx_check
  CHECK ((type = 'fx_diff') = (fx_anchor_id IS NOT NULL)
         AND (type <> 'fx_diff' OR (account_id IS NULL AND partner_id IS NULL AND batch_id IS NULL
                                    AND deal_id IS NULL AND method IS NULL
                                    AND amount_usd <> 0 AND amount_usd <> 'NaN'::numeric)));
CREATE UNIQUE INDEX client_transactions_fx_anchor_uniq
  ON client_transactions (fx_anchor_id, currency) WHERE type = 'fx_diff' AND voided_at IS NULL;
-- «Was this cycle ever managed?» asks voided rows too.
CREATE INDEX client_transactions_fx_anchor_idx
  ON client_transactions (fx_anchor_id) WHERE fx_anchor_id IS NOT NULL;

ALTER TABLE partner_transactions DROP CONSTRAINT partner_tx_type_check;
ALTER TABLE partner_transactions ADD CONSTRAINT partner_tx_type_check
  CHECK (type IN ('charge', 'receipt', 'payment', 'offset', 'adjust', 'fx_diff'));
ALTER TABLE partner_transactions DROP CONSTRAINT partner_tx_amount_check;
ALTER TABLE partner_transactions ADD CONSTRAINT partner_tx_amount_check
  CHECK (CASE WHEN type = 'adjust' THEN amount <> 0
              WHEN type = 'fx_diff' THEN amount = 0
              ELSE amount > 0 END);
ALTER TABLE partner_transactions ADD COLUMN fx_anchor_id uuid REFERENCES partner_transactions(id);
ALTER TABLE partner_transactions ADD CONSTRAINT partner_tx_fx_check
  CHECK ((type = 'fx_diff') = (fx_anchor_id IS NOT NULL)
         AND (type <> 'fx_diff' OR (cost_entry_id IS NULL AND expense_id IS NULL AND client_tx_id IS NULL
                                    AND batch_id IS NULL
                                    AND amount_usd <> 0 AND amount_usd <> 'NaN'::numeric)));
-- partner_tx_account_check already forbids a kassa on anything but receipt/payment.
CREATE UNIQUE INDEX partner_tx_fx_anchor_uniq
  ON partner_transactions (fx_anchor_id, currency) WHERE type = 'fx_diff' AND voided_at IS NULL;
CREATE INDEX partner_tx_fx_anchor_idx
  ON partner_transactions (fx_anchor_id) WHERE fx_anchor_id IS NOT NULL;

-- Q12's split (the lead's reading): what a hand-typed adjust IS. NULL =
-- history nobody classified, or an adjust typed by someone who may not
-- classify (the VED, Q19): it is NAMED beside the P&L and never guessed into it.
ALTER TABLE partner_transactions ADD COLUMN adjust_kind text;
ALTER TABLE partner_transactions ADD CONSTRAINT partner_tx_adjust_kind_check
  CHECK (adjust_kind IS NULL OR (type = 'adjust' AND adjust_kind IN ('fx', 'correction')));

-- Q14's boundary for PARTNER history (#415's hand-closed residues live there):
-- a partner cycle holding a row typed before this INSTANT is closed by a
-- person on /accounting/kurs-farqi, never by itself. Written ONCE, here, as an
-- instant (a day would put this morning's hand closes on the wrong side).
-- Deliberately NOT a settings-screen key: no screen renders or saves it,
-- because moving it back would re-post every hand-closed residue a second time.
INSERT INTO settings (key, value)
VALUES ('fx_residue_since',
        to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
ON CONFLICT (key) DO NOTHING;
