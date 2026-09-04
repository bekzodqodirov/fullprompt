-- VED 2.0 phase 4, item 5: the offer learns a second anchor — the Готово
-- answer. While the dictionaries are empty every production price is a typed
-- answer (completed_via 'task', answer_amount), and phase C/D's whole offer /
-- PDF / upsale machinery was invisible for it. An offer now stands on exactly
-- ONE of: a sealed version (as before) or a completed request's answer.
ALTER TABLE "calc_offers" ALTER COLUMN "version_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "calc_offers" ADD COLUMN "request_id" uuid REFERENCES "calc_requests"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- Exactly one anchor: a row with both is two floors for one promise, a row
-- with neither is a promise measured against nothing.
ALTER TABLE "calc_offers" ADD CONSTRAINT "calc_offers_one_anchor_check"
  CHECK (("version_id" IS NULL) <> ("request_id" IS NULL));
--> statement-breakpoint
CREATE INDEX "calc_offers_request_idx" ON "calc_offers" ("request_id") WHERE "request_id" IS NOT NULL;
--> statement-breakpoint
-- The answer becomes a FLOOR money is measured against, so it inherits the
-- money columns' discipline: positive, never NaN (round 110's lesson — the
-- column is written from Number() paths). NOT VALID because production rows
-- predate the rule; new writes are checked from here on.
ALTER TABLE "calc_requests" ADD CONSTRAINT "calc_requests_answer_amount_check"
  CHECK ("answer_amount" IS NULL OR ("answer_amount" > 0 AND "answer_amount" <> 'NaN'::numeric)) NOT VALID;
