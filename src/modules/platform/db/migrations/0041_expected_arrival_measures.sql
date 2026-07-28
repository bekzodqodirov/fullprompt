-- The promise learns the two numbers the price is made of (owner, 2026-07-28:
-- "karobka soniga urg'u berilgan, bu yerda kubi kilosi ham muhim").
-- Purely additive: old promises simply have no measures.
ALTER TABLE expected_arrivals
  ADD COLUMN IF NOT EXISTS weight_kg numeric(12, 3),
  ADD COLUMN IF NOT EXISTS volume_m3 numeric(12, 4);
