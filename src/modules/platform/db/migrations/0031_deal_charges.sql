-- A charge belongs to the job it is for.
--
-- Without this the deferred payment agreed in docs/DEALS.md is a note that
-- changes nothing: the deferral says "the money for THIS job waits until every
-- box is here", and the handover gate had no way to tell which part of the
-- client's balance that was. The gate would keep blocking, the operator would
-- keep pressing the override, and the whole record of who agreed what would go
-- back to being a Telegram message.
--
-- Nullable for ever and purely additive: every charge posted from batch
-- pricing since Phase 2.1 has no deal, and that is a correct answer, not a
-- gap — a deferral simply cannot cover a charge nobody tied to a job.
ALTER TABLE client_transactions ADD COLUMN deal_id uuid REFERENCES deals(id);
--> statement-breakpoint
-- The gate asks this on every handover: "what does this client owe on
-- currently deferred jobs".
CREATE INDEX client_transactions_deal_idx ON client_transactions (deal_id)
  WHERE deal_id IS NOT NULL;
