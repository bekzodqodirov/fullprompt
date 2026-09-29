-- Oylik + KPI (owner, 2026-09-29, answers 1a / 2a / 3a / 4a / 5b / 6b / 7a / 8a).
--
-- (1) WHOSE cargo it is, written down ON THE DAY IT WAS RECEIVED (his 2a: «a
-- client moved to another seller keeps the old cargo with whoever was the
-- seller that day»). `clients.sales_manager_id` is the book as it stands NOW,
-- so it cannot answer a question about last month — a column on the receipt,
-- written in the same statement as `receipts.client_id` by its two writers
-- (`confirmReceipt`'s INSERT, `assignReceiptClient`'s UPDATE), is the only
-- place that can. NULL = the client had no seller that day; the first seller
-- named afterwards takes that cargo (`stampUnattributedCargo`, and the
-- backfill below says the same sentence).
ALTER TABLE receipts ADD COLUMN sales_manager_id uuid REFERENCES users(id);
--> statement-breakpoint
-- The KPI's own read: one seller's confirmed receipts over a Tashkent month.
CREATE INDEX receipts_seller_received_idx ON receipts (sales_manager_id, received_at)
  WHERE status = 'confirmed' AND sales_manager_id IS NOT NULL;
--> statement-breakpoint
-- …and «Sotuvchisiz yuk», the month's cargo nobody was named on.
CREATE INDEX receipts_unstamped_received_idx ON receipts (received_at)
  WHERE status = 'confirmed' AND sales_manager_id IS NULL AND client_id IS NOT NULL;
--> statement-breakpoint
-- (2) His KPI table ($ per m³ by the month's m³ tier × the month's average
-- density band), VERSIONED by the month it starts to apply — the tariff's and
-- the price book's shape, with no earliest-row fallback: a month before the
-- first version is simply outside KPI. One row per cell; NULL max = the open
-- top («>150», «от 350»). Both bounds inclusive at the top (his 3a/4a).
CREATE TABLE kpi_rates (
  id uuid PRIMARY KEY NOT NULL,
  effective_month date NOT NULL,
  max_m3 numeric(10,3),
  max_density integer,
  rate_usd numeric(8,2) NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kpi_rates_month_check CHECK (effective_month = date_trunc('month', effective_month)::date),
  -- `<> 'NaN'` is the only comparison postgres has that excludes NaN (#777):
  -- NaN answers TRUE to `> 0`.
  CONSTRAINT kpi_rates_max_m3_check CHECK (max_m3 IS NULL OR (max_m3 > 0 AND max_m3 <> 'NaN'::numeric)),
  CONSTRAINT kpi_rates_max_density_check CHECK (max_density IS NULL OR max_density > 0),
  CONSTRAINT kpi_rates_rate_check CHECK (rate_usd >= 0 AND rate_usd <> 'NaN'::numeric)
);
--> statement-breakpoint
CREATE UNIQUE INDEX kpi_rates_cell ON kpi_rates (effective_month, coalesce(max_m3, -1), coalesce(max_density, -1));
--> statement-breakpoint
-- (3) A KPI payout: an ordinary expense (the P&L, the cash flow and the
-- expense book see it for free) plus this SNAPSHOT of what it paid for. A
-- payout is LIVE while its expense is: every reader joins `expenses` with
-- `voided_at IS NULL`, so a voided payout re-opens its money by derivation
-- and there is no hook to forget (#528 made structural). Payable is netted
-- per SELLER across every closed month, so a month re-counted after a late
-- claim or a correction can never pay twice.
CREATE TABLE kpi_payouts (
  id uuid PRIMARY KEY NOT NULL,
  seller_id uuid NOT NULL REFERENCES users(id),
  expense_id uuid NOT NULL UNIQUE REFERENCES expenses(id),
  amount_usd numeric(14,2) NOT NULL,
  through_month date NOT NULL,
  earned_paid_usd numeric(14,2) NOT NULL,
  paid_before_usd numeric(14,2) NOT NULL,
  -- [{month,m3,kg,density,tierMaxM3,bandMaxDensity,rate,paidM3,earnedPaidUsd}]
  breakdown jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kpi_payouts_amount_check CHECK (amount_usd > 0 AND amount_usd <> 'NaN'::numeric),
  CONSTRAINT kpi_payouts_month_check CHECK (through_month = date_trunc('month', through_month)::date),
  CONSTRAINT kpi_payouts_earned_check CHECK (earned_paid_usd <> 'NaN'::numeric),
  CONSTRAINT kpi_payouts_before_check CHECK (paid_before_usd <> 'NaN'::numeric)
);
--> statement-breakpoint
CREATE INDEX kpi_payouts_seller_idx ON kpi_payouts (seller_id);
--> statement-breakpoint
-- The backfill: the manager in force on the RECEIPT DAY, read off the client's
-- audit history (`diffFields` writes both halves of a changed key; `create`
-- writes the after):
--   - the `before` of the NEXT audited change after the receipt day, else the
--     CURRENT manager (an unaudited later change — the import script's old
--     `--update` — is not lost);
--   - a NULL in force is «nobody» → the first manager named afterwards (the
--     live rule `stampUnattributedCargo` states the same sentence), else the
--     current one.
-- A stored value that is not a uuid is read as absent rather than failing the
-- whole migration on one odd audit row; an id whose user no longer exists is
-- left NULL rather than failing the foreign key. Both laterals ride
-- `audit_entity_idx` (entity_type, entity_id, created_at).
-- The design's `CASE WHEN nx.found IS NULL THEN current ELSE nx.before_m END`
-- is this coalesce exactly: with no later audited change there is no `dx`
-- either (every `dx` row is an `nx` candidate), so both read the current
-- manager — its red proof stayed green, and the dead branch is gone.
UPDATE receipts r SET sales_manager_id = s.m
FROM (
  SELECT r2.id,
         coalesce(nx.before_m, dx.m, c.sales_manager_id) AS m
    FROM receipts r2
    JOIN clients c ON c.id = r2.client_id
    LEFT JOIN LATERAL (
      SELECT CASE WHEN a.before->>'salesManagerId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN (a.before->>'salesManagerId')::uuid END AS before_m
        FROM audit_log a
       WHERE a.entity_type = 'client' AND a.entity_id = r2.client_id AND a.created_at > r2.received_at
         AND a.action IN ('create', 'update') AND a.after ? 'salesManagerId'
       ORDER BY a.created_at, a.id
       LIMIT 1) nx ON true
    LEFT JOIN LATERAL (
      SELECT (a.after->>'salesManagerId')::uuid AS m
        FROM audit_log a
       WHERE a.entity_type = 'client' AND a.entity_id = r2.client_id AND a.created_at > r2.received_at
         AND a.action IN ('create', 'update')
         AND a.after->>'salesManagerId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       ORDER BY a.created_at, a.id
       LIMIT 1) dx ON true
   WHERE r2.client_id IS NOT NULL) s
WHERE r.id = s.id AND s.m IS NOT NULL AND EXISTS (SELECT 1 FROM users u WHERE u.id = s.m);
