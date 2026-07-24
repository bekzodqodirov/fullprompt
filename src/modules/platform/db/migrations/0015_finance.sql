-- Phase 2.1: client money ledger (owner's rules: no tariffs — the price is
-- negotiated per shipment; VED manager + accountant set it after customs;
-- payments arrive as cash/card/transfer in any currency; debtors get cargo
-- only with a manager's permission).
CREATE TABLE "client_transactions" (
  "id" uuid PRIMARY KEY,
  "client_id" uuid NOT NULL REFERENCES "clients"("id"),
  "type" text NOT NULL,
  "amount" numeric(14, 2) NOT NULL,
  "currency" varchar(3) NOT NULL REFERENCES "currencies"("code"),
  "rate_to_usd" numeric(18, 8) NOT NULL,
  "amount_usd" numeric(14, 2) NOT NULL,
  "method" text,
  "tx_date" date NOT NULL,
  "batch_id" uuid REFERENCES "batches"("id"),
  "note" text,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "voided_at" timestamptz,
  "voided_by" uuid REFERENCES "users"("id"),
  "void_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "client_transactions_type_check" CHECK ("type" IN ('charge', 'payment')),
  CONSTRAINT "client_transactions_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "client_transactions_method_check" CHECK ("method" IS NULL OR "method" IN ('cash', 'card', 'transfer'))
);
CREATE INDEX "client_transactions_client_idx" ON "client_transactions" ("client_id", "created_at");
CREATE INDEX "client_transactions_batch_idx" ON "client_transactions" ("batch_id");
