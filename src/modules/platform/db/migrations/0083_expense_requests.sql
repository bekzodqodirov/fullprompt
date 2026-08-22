-- Rasxod xabari (round 107, owner's item 5): the warehouse operator reports
-- money spent — summa, izoh, chek photo — and whoever holds finance.expenses
-- enters the REAL expense with the right kontragent. The skladchi never
-- touches the expense book; this table is the queue between them, and the
-- record of what became of each report.
--
-- expense_id lands only after the expense saved (a partial unique makes an
-- expense answer at most one request); a rejection is exactly a written
-- reason, the 0054 paired-CHECK idiom.

CREATE TABLE expense_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  amount numeric(14,2) NOT NULL,
  currency varchar(3) NOT NULL REFERENCES currencies(code),
  note text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  expense_id uuid REFERENCES expenses(id),
  reject_reason text,
  CONSTRAINT expense_requests_amount_check CHECK (amount > 0),
  CONSTRAINT expense_requests_status_check CHECK (status IN ('open', 'done', 'rejected')),
  CONSTRAINT expense_requests_reject_check CHECK ((status = 'rejected') = (reject_reason IS NOT NULL))
);

CREATE UNIQUE INDEX expense_requests_expense_unique
  ON expense_requests (expense_id) WHERE expense_id IS NOT NULL;
CREATE INDEX expense_requests_status_idx ON expense_requests (status, created_at);
CREATE INDEX expense_requests_author_idx ON expense_requests (created_by, created_at);
