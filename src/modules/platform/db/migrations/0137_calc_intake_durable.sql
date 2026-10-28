-- Sakkiz band round 3 (docs/SAKKIZ-R3.md), migration 0137 — after Uch band's 0136.
-- His 1.8 c: an unfinished «Hisoblatish» waits 24 hours and survives a deploy. His 1.9 a:
-- what arrives after the job landed joins THAT job while the VED has not started. His 2.8 b: the law's missing count is asked after the AI
-- answer. Nothing is backfilled. gsr_ai_reader (0080, allowlist default-deny) is granted
-- NOTHING on either new table. The four new `calc_requests` columns are readable through
-- 0080's table-level grant on `calc_requests` (no secret in them, stated);
-- `ai_calc_passes.intake_note_id` is not (the table is not granted).

-- (1) The collection, written behind memory (the 0130 idiom). One per chat. The note id is
-- the collection's identity: its files are pre-bound to it, and a landed or added collection
-- is recognised by it.
CREATE TABLE "telegram_calc_intakes" (
  "chat_id" bigint PRIMARY KEY,
  "staff_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "note_id" uuid NOT NULL,
  "state" jsonb NOT NULL,
  "opened_at" timestamptz NOT NULL,
  "touched_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  CONSTRAINT "telegram_calc_intakes_note_unique" UNIQUE ("note_id"),
  CONSTRAINT "telegram_calc_intakes_state_check" CHECK (jsonb_typeof("state") = 'object'),
  CONSTRAINT "telegram_calc_intakes_window_check" CHECK ("opened_at" <= "touched_at" AND "touched_at" < "expires_at")
);
-- No index on expires_at: every write changes it (an index would rule out HOT updates and
-- add an index write per message), and the table holds one row per staff chat, which the
-- hydrate and the nightly prune scan anyway.
--> statement-breakpoint
-- (2) Who touched the request last. `handsoff_rev` = the revision the machine's pass or the
-- seller's own addition left; equal to `rev` = no person has written since (his 1.9 a «VED
-- hali boshlamagan»). NULL = not known (requests before this migration, corrections). The
-- landing writes 0 (rev's own default).
ALTER TABLE "calc_requests" ADD COLUMN "handsoff_rev" integer;
--> statement-breakpoint
-- (3) A machine pass owed or running: the ticket it was queued at, and when. Set by
-- `queueCalcPrefill` on whichever queue the section names (`calc.prefill` or
-- `calc.tariff-reply`, `passQueueOf`) and cleared by THAT queue's worker's settle
-- (`settlePass`; both workers settle). Neither moves `rev`.
ALTER TABLE "calc_requests" ADD COLUMN "ai_pass_rev" integer;
--> statement-breakpoint
ALTER TABLE "calc_requests" ADD COLUMN "ai_pass_at" timestamptz;
--> statement-breakpoint
-- The pass's own pg-boss job, the id `enqueue` was given (K: `EnqueueOptions.id`; the queue
-- is re-derived from the row's section): «busy» is «that job is alive», never a time window.
ALTER TABLE "calc_requests" ADD COLUMN "ai_pass_job" uuid;
--> statement-breakpoint
ALTER TABLE "calc_requests" ADD CONSTRAINT "calc_requests_ai_pass_check"
  CHECK (("ai_pass_rev" IS NULL) = ("ai_pass_at" IS NULL)
     AND ("ai_pass_rev" IS NULL) = ("ai_pass_job" IS NULL));
--> statement-breakpoint
-- (4) What a seller added to a landed request, and what became of it: written into the rows
-- ('applied'), handed to the VED ('to_ved'), stored until the running machine pass ends
-- ('waiting'), or only filed on the card ('noted'). The note id is the once-key: a redelivered
-- or repeated «✅ Qo‘shish» finds it. The submission is kept so a 'waiting' row can be written
-- later by the job alone, and the chat so its words reach the seller.
CREATE TABLE "calc_amendments" (
  "id" uuid PRIMARY KEY,
  "request_id" uuid NOT NULL REFERENCES "calc_requests"("id") ON DELETE CASCADE,
  "note_id" uuid NOT NULL,
  "staff_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "chat_id" bigint NOT NULL,
  "outcome" text NOT NULL,
  "rev" integer,
  "submission" jsonb NOT NULL,
  "change" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- when the seller was told the CURRENT outcome (NULL again when a 'waiting' row moves on)
  "outcome_sent_at" timestamptz,
  -- when the thread message's ping finished (the message itself is in the save's transaction)
  "announced_at" timestamptz,
  CONSTRAINT "calc_amendments_note_unique" UNIQUE ("note_id"),
  CONSTRAINT "calc_amendments_outcome_check" CHECK ("outcome" IN ('waiting', 'applied', 'to_ved', 'noted')),
  CONSTRAINT "calc_amendments_rev_check" CHECK (("outcome" = 'applied') = ("rev" IS NOT NULL)),
  CONSTRAINT "calc_amendments_change_check" CHECK (jsonb_typeof("change") = 'object'),
  CONSTRAINT "calc_amendments_submission_check" CHECK (jsonb_typeof("submission") = 'object')
);
--> statement-breakpoint
CREATE INDEX "calc_amendments_request_idx" ON "calc_amendments" ("request_id", "created_at");
--> statement-breakpoint
-- P6's refusal asks «an applied addition after the revision the VED saw», on every door press.
CREATE INDEX "calc_amendments_applied_idx" ON "calc_amendments" ("request_id", "rev")
  WHERE "outcome" = 'applied';
--> statement-breakpoint
-- The settle and the sweep look for what waits.
CREATE INDEX "calc_amendments_waiting_idx" ON "calc_amendments" ("request_id")
  WHERE "outcome" = 'waiting';
--> statement-breakpoint
-- (5) A collection's model reading is billed when the model answers, before any request
-- exists (R2 §8.2.7's stated hole), dated by the answer as R2's late pass already did
-- (concurrency-11): `intake_note_id` anchors it, and the landing sets `request_id`. The
-- collector's own subtraction of its unlanded readings goes in the same release (P2), or
-- each reading counts twice. The anchor CHECK keeps 0119's two rules and adds the third.
ALTER TABLE "ai_calc_passes" ADD COLUMN "intake_note_id" uuid;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" DROP CONSTRAINT IF EXISTS "ai_calc_passes_anchor_check";
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD CONSTRAINT "ai_calc_passes_anchor_check" CHECK (
  CASE "kind"
    WHEN 'similar' THEN "request_id" IS NULL AND "intake_note_id" IS NULL
    WHEN 'intake'  THEN "request_id" IS NOT NULL OR "intake_note_id" IS NOT NULL
    ELSE "request_id" IS NOT NULL AND "intake_note_id" IS NULL
  END);
--> statement-breakpoint
CREATE INDEX "ai_calc_passes_intake_note_idx" ON "ai_calc_passes" ("intake_note_id")
  WHERE "intake_note_id" IS NOT NULL;
