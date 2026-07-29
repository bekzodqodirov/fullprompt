-- Phase 6: issuing to a debtor goes through a recorded request/decision
-- instead of a phone call. Additive only. The gate re-checks validity at
-- read time (status, expiry, amount), the same way the deal deferral gate
-- does — no sweep needed for correctness.

CREATE TABLE IF NOT EXISTS issue_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  -- Snapshot of (balance - deferred) at request time: the approved ceiling.
  -- If the debt GROWS past it, the approval no longer covers the client.
  blocking_debt_usd numeric(14,2) NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  request_note text,
  status text NOT NULL DEFAULT 'pending',
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text,
  -- Set at decision time: now() + debt_approval_ttl_hours.
  expires_at timestamptz,
  consumed_handover_id uuid REFERENCES handovers(id),
  consumed_at timestamptz,
  CONSTRAINT issue_approvals_status_check
    CHECK (status IN ('pending', 'approved', 'refused', 'consumed')),
  CONSTRAINT issue_approvals_decided_check
    CHECK ((status = 'pending') = (decided_by IS NULL)),
  CONSTRAINT issue_approvals_consumed_check
    CHECK ((status = 'consumed') = (consumed_handover_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS issue_approvals_gate_idx
  ON issue_approvals (client_id, warehouse_id, status);
