-- Rastamojka is decided per PRIXOD, not only per truck.
--
-- Round 39 put the customs firm on the batch, which is right for the usual
-- case — one truck, one firm. The owner then named the case that breaks it:
-- inside one truck, some clients clear their own cargo through their own
-- firm and we clear the rest. A batch-level answer cannot say that, and the
-- money follows the answer: a prixod the client cleared costs us nothing.
--
-- The batch keeps its column as the DEFAULT for the truck; a receipt that
-- states its own overrides it. Both nullable, so every existing row keeps
-- meaning exactly what it meant before this migration.
ALTER TABLE receipts ADD COLUMN customs_partner_id uuid REFERENCES partners(id);
ALTER TABLE receipts ADD COLUMN customs_by_client boolean;

-- Read together with the batch on every customs screen, and small enough
-- that the index earns its place only where the pointer is actually set.
CREATE INDEX receipts_customs_partner_idx ON receipts(customs_partner_id)
  WHERE customs_partner_id IS NOT NULL;
