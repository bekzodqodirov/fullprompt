-- The owner's rule, widened at his ask (2026-08-06 kech): a call with a
-- number written on an OPEN lead is company business too — «nomer yozilib
-- lead ochildimi, usha telefondan klient tel qilganda zapislari yozilib
-- qolsin». The privacy door becomes «client book OR an open lead»; a number
-- on neither is still answered matched:false and never stored, and the
-- CHECK keeps that structural: every stored call names its owner.
ALTER TABLE call_logs ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE call_logs ADD COLUMN lead_id uuid REFERENCES leads(id);
ALTER TABLE call_logs ADD CONSTRAINT call_logs_owner_check
  CHECK (client_id IS NOT NULL OR lead_id IS NOT NULL);
CREATE INDEX call_logs_lead_idx ON call_logs (lead_id, started_at DESC)
  WHERE lead_id IS NOT NULL;
