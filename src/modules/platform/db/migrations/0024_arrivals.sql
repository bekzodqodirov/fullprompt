-- Only some warehouses hand cargo to the client (owner: TAS and AND do,
-- the Chinese warehouses and the customs yard never do). It was a permission
-- until now, which meant every warehouse operator got a "Handover" screen
-- that would never have a client standing in front of it.
--
-- Seeded from the type rather than defaulted to false: customs/distribution
-- warehouses ARE the ones the cargo is collected from, and a migration that
-- silently switched handover off everywhere would be a production outage.
ALTER TABLE warehouses ADD COLUMN issues_to_clients boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE warehouses SET issues_to_clients = true WHERE type IN ('customs', 'distribution');
--> statement-breakpoint

-- Cargo a client has told us is on its way to one of our warehouses.
--
-- The sales side hears "I'm sending five boxes to Yiwu on Friday" days before
-- the boxes exist anywhere in this system; until now that sentence lived in a
-- chat and the warehouse found out when a courier walked in. A waiting row is
-- a promise, not stock: it holds no boxes, no letters and no money.
CREATE TABLE expected_arrivals (
  id uuid PRIMARY KEY,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  -- One of the two, checked below: a known client, or a marking written on
  -- the boxes by someone who is not our client yet.
  client_id uuid REFERENCES clients(id),
  marking text,
  /** Rough — the client's own count, which the receipt will correct. */
  box_count integer,
  expected_on date,
  note text,
  status text NOT NULL DEFAULT 'waiting',
  /** Set when the cargo actually turned up, pointing at the receipt. */
  receipt_id uuid REFERENCES receipts(id),
  arrived_at timestamptz,
  cancel_reason text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expected_arrivals_status_check
    CHECK (status IN ('waiting', 'arrived', 'cancelled')),
  CONSTRAINT expected_arrivals_who_check
    CHECK (client_id IS NOT NULL OR marking IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX expected_arrivals_open_idx
  ON expected_arrivals (warehouse_id, expected_on)
  WHERE status = 'waiting';
--> statement-breakpoint
CREATE INDEX expected_arrivals_client_idx ON expected_arrivals (client_id);
