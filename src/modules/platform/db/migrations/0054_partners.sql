-- Kontragentlar — who WE owe, and who owes us that is not a client.
--
-- Until now money had exactly one counterparty: the client. Everything else
-- was a cost with no creditor and no paid/unpaid state, so "we owe the
-- transport company for eleven trucks" lived in somebody's head. The owner's
-- three cases all need the same thing: an account per counterparty.
--
-- Types are DATA, not code (owner: «hardcoded bolmasligi kerak»): the seed
-- puts four in and the screen owns them afterwards.
CREATE TABLE partner_types (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A counterparty may BE one of our clients (owner: «kontragent klient
-- bolishi ham mumkun»). One card, two ledgers: what they owe us for cargo
-- stays on the client ledger, what we owe them for services lands here.
CREATE TABLE partners (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  type_id uuid NOT NULL REFERENCES partner_types(id),
  client_id uuid REFERENCES clients(id),
  phone text,
  note text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One partner account per client: two accounts for the same person would
-- each show half the truth, which is worse than none.
CREATE UNIQUE INDEX partners_client_uniq ON partners(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX partners_type_idx ON partners(type_id) WHERE active;

-- The partner ledger. Sign: charge and receipt RAISE what we owe, payment
-- and offset LOWER it, adjust does either (the rate difference the owner
-- books as profit when a cash buyer's two legs do not meet).
--
--   charge   they billed us / we took the service   debt +   no cash
--   receipt  they put money into one of OUR accounts debt +   cash +
--   payment  we paid them out of a cash box          debt -   cash -
--   offset   a client paid them on our behalf        debt -   no cash
--   adjust   correction / rate difference            either   no cash
CREATE TABLE partner_transactions (
  id uuid PRIMARY KEY,
  partner_id uuid NOT NULL REFERENCES partners(id),
  type text NOT NULL,
  -- Signed for 'adjust' only; every other type carries its sign in `type`.
  amount numeric(14,2) NOT NULL,
  currency varchar(3) NOT NULL REFERENCES currencies(code),
  rate_to_usd numeric(24,12) NOT NULL,
  amount_usd numeric(14,2) NOT NULL,
  tx_date date NOT NULL,
  -- Which cash box moved. NULL for charge/offset/adjust, which move none.
  account_id uuid REFERENCES money_accounts(id),
  -- A truck line points at the batch it carried, so the cost side and the
  -- debt side of the same truck can be read against each other.
  batch_id uuid REFERENCES batches(id),
  cost_entry_id uuid REFERENCES cost_entries(id),
  expense_id uuid REFERENCES expenses(id),
  -- The client payment this offset pairs with (three-cornered settlement).
  client_tx_id uuid REFERENCES client_transactions(id),
  note text,
  created_by uuid NOT NULL REFERENCES users(id),
  voided_at timestamptz,
  voided_by uuid REFERENCES users(id),
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_tx_type_check
    CHECK (type IN ('charge', 'receipt', 'payment', 'offset', 'adjust')),
  -- Zero is not an entry. Only an adjustment may be negative.
  CONSTRAINT partner_tx_amount_check
    CHECK (CASE WHEN type = 'adjust' THEN amount <> 0 ELSE amount > 0 END),
  -- Money that moved must say WHERE from; money that did not must not claim to.
  CONSTRAINT partner_tx_account_check
    CHECK ((type IN ('receipt', 'payment')) = (account_id IS NOT NULL))
);

CREATE INDEX partner_tx_partner_idx ON partner_transactions(partner_id, tx_date DESC);
CREATE INDEX partner_tx_batch_idx ON partner_transactions(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX partner_tx_account_idx ON partner_transactions(account_id, tx_date)
  WHERE account_id IS NOT NULL;

-- A cost or an overhead somebody ELSE settled. The cost still belongs to the
-- cargo — tannarx must not change — but our cash box never opened, so the
-- cash-flow report must not claim it did and the debt has to land somewhere.
ALTER TABLE cost_entries ADD COLUMN partner_id uuid REFERENCES partners(id);
ALTER TABLE expenses ADD COLUMN partner_id uuid REFERENCES partners(id);

-- A client payment that reached us through a partner's account rather than a
-- cash box of ours (owner: «klient qarzini transport firmasining hisobiga
-- tushiradi»). `account_id` stays NULL on these by construction.
ALTER TABLE client_transactions ADD COLUMN partner_id uuid REFERENCES partners(id);

-- Which firm cleared this truck through customs. Ours (a partner) or the
-- client's own — the owner's case where the cost never touches us at all,
-- and only the fact of who did it is worth recording.
ALTER TABLE batches ADD COLUMN customs_partner_id uuid REFERENCES partners(id);
ALTER TABLE batches ADD COLUMN customs_by_client boolean NOT NULL DEFAULT false;
