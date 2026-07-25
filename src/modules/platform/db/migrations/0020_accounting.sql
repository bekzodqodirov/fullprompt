-- Phase 2.4 management accounting: the overhead side of the books and
-- somewhere for money to actually sit. Cargo costs already exist
-- (cost_entries → cost_allocations); this adds what a P&L was missing.

CREATE TABLE expense_categories (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  cash boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE money_accounts (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  currency varchar(3) NOT NULL REFERENCES currencies(code),
  kind text NOT NULL DEFAULT 'cash',
  opening_balance numeric(16, 2) NOT NULL DEFAULT 0,
  opening_date date,
  sort_order integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT money_accounts_kind_check CHECK (kind IN ('cash', 'bank', 'card'))
);
--> statement-breakpoint
CREATE TABLE expenses (
  id uuid PRIMARY KEY,
  category_id uuid NOT NULL REFERENCES expense_categories(id),
  amount numeric(14, 2) NOT NULL,
  currency varchar(3) NOT NULL REFERENCES currencies(code),
  rate_to_usd numeric(18, 8) NOT NULL,
  amount_usd numeric(14, 2) NOT NULL,
  expense_date date NOT NULL,
  warehouse_id uuid REFERENCES warehouses(id),
  employee_id uuid REFERENCES users(id),
  account_id uuid REFERENCES money_accounts(id),
  note text,
  created_by uuid NOT NULL REFERENCES users(id),
  voided_at timestamptz,
  voided_by uuid REFERENCES users(id),
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expenses_amount_check CHECK (amount > 0)
);
--> statement-breakpoint
CREATE INDEX expenses_date_idx ON expenses (expense_date);
--> statement-breakpoint
CREATE INDEX expenses_category_idx ON expenses (category_id, expense_date);
--> statement-breakpoint
CREATE INDEX expenses_account_idx ON expenses (account_id, expense_date);
--> statement-breakpoint
CREATE TABLE recurring_expenses (
  id uuid PRIMARY KEY,
  category_id uuid NOT NULL REFERENCES expense_categories(id),
  amount numeric(14, 2) NOT NULL,
  currency varchar(3) NOT NULL REFERENCES currencies(code),
  day_of_month integer NOT NULL DEFAULT 1,
  warehouse_id uuid REFERENCES warehouses(id),
  employee_id uuid REFERENCES users(id),
  account_id uuid REFERENCES money_accounts(id),
  note text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recurring_expenses_amount_check CHECK (amount > 0),
  CONSTRAINT recurring_expenses_day_check CHECK (day_of_month BETWEEN 1 AND 28)
);
--> statement-breakpoint
CREATE TABLE account_transfers (
  id uuid PRIMARY KEY,
  from_account_id uuid NOT NULL REFERENCES money_accounts(id),
  to_account_id uuid NOT NULL REFERENCES money_accounts(id),
  amount_from numeric(14, 2) NOT NULL,
  amount_to numeric(14, 2) NOT NULL,
  amount_usd numeric(14, 2) NOT NULL,
  transfer_date date NOT NULL,
  note text,
  created_by uuid NOT NULL REFERENCES users(id),
  voided_at timestamptz,
  voided_by uuid REFERENCES users(id),
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_transfers_amount_check CHECK (amount_from > 0 AND amount_to > 0),
  CONSTRAINT account_transfers_distinct_check CHECK (from_account_id <> to_account_id)
);
--> statement-breakpoint
CREATE INDEX account_transfers_date_idx ON account_transfers (transfer_date);
--> statement-breakpoint
-- Which cash box a client payment landed in (nullable: existing rows predate accounts).
ALTER TABLE client_transactions ADD COLUMN account_id uuid REFERENCES money_accounts(id);
--> statement-breakpoint
CREATE INDEX client_transactions_account_idx ON client_transactions (account_id, tx_date);
