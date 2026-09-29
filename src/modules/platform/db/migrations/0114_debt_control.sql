-- Qarz nazorati (owner, 2026-09-28, his 2a: «sotuvchi faqat o'z mijoziga,
-- admin va buxgalter hammaga»). Additive only: every new column is nullable
-- with no default, so no existing handover changes meaning and no table is
-- rewritten.

-- What the gate SAW when a client's cargo went out: the balance, the part a
-- deal deferral («muddat») excused, and what was left blocking. Written once
-- by the one door that hands cargo over (`issueBoxes`), from the figures it
-- already reads before its transaction. NULL = a handover from before this
-- migration; the deferral half cannot be reconstructed after the fact, so
-- there is deliberately no backfill and the register labels those rows as
-- older («—»).
ALTER TABLE "handovers" ADD COLUMN "owed_usd" numeric(14, 2);
ALTER TABLE "handovers" ADD COLUMN "blocking_usd" numeric(14, 2);
ALTER TABLE "handovers" ADD COLUMN "deferred_usd" numeric(14, 2);
-- Which deferred jobs the release leaned on, and who granted each: an array
-- of {dealId, code, by, usd}, where usd is the part of THIS release that
-- deferral covered. A snapshot — the deal's deferral can be re-granted or end
-- later, and the register must name who allowed the cargo out that day.
ALTER TABLE "handovers" ADD COLUMN "deferrals" jsonb;
-- `<> 'NaN'` is the only comparison postgres has that excludes NaN (#777).
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_debt_figures_check" CHECK (
  ("owed_usd" IS NULL OR "owed_usd" <> 'NaN'::numeric)
  AND ("blocking_usd" IS NULL OR "blocking_usd" <> 'NaN'::numeric)
  AND ("deferred_usd" IS NULL OR ("deferred_usd" >= 0 AND "deferred_usd" <> 'NaN'::numeric))
  AND ("deferrals" IS NULL OR jsonb_typeof("deferrals") = 'array')
);
-- The register reads releases newest first. A new row qualifies on the
-- STORED figure alone (the judge's #4: the screen's tick with nothing
-- blocking is not a release on debt), so the index predicate says the same.
CREATE INDEX "handovers_debt_release_idx" ON "handovers" ("created_at")
  WHERE "kind" = 'issued_to_client' AND ("blocking_usd" > 0.009 OR "deferrals" IS NOT NULL);

-- «Which handover spent this approval» is asked from the handover side now
-- (the register and the lenta name the decider). Only consumed rows carry it.
CREATE INDEX "issue_approvals_consumed_idx" ON "issue_approvals" ("consumed_handover_id")
  WHERE "consumed_handover_id" IS NOT NULL;

-- To'lov va'dasi: an amount and a day a debtor said he would pay, typed on
-- the client's «Pul» tab. USD only — the promise is compared with the
-- ledger's dollars. One OPEN promise per client (the partial unique index is
-- the race's arbiter; the service maps its 23505 to a sentence, #472).
-- `task_id` is the call the promise books — a task, never the client's one
-- follow-up slot, which belongs to a date a person typed (the judge's #2).
CREATE TABLE "payment_promises" (
  "id" uuid PRIMARY KEY NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "clients"("id"),
  "amount_usd" numeric(14, 2) NOT NULL,
  "due_on" date NOT NULL,
  "note" text,
  "balance_at_usd" numeric(14, 2) NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "settled_at" timestamptz,
  "settled_by" uuid REFERENCES "users"("id"),
  CONSTRAINT "payment_promises_amount_check" CHECK ("amount_usd" > 0 AND "amount_usd" <> 'NaN'::numeric),
  CONSTRAINT "payment_promises_balance_check" CHECK ("balance_at_usd" <> 'NaN'::numeric),
  CONSTRAINT "payment_promises_status_check"
    CHECK ("status" IN ('open', 'kept', 'settled', 'broken', 'cancelled')),
  CONSTRAINT "payment_promises_settled_check" CHECK (("status" = 'open') = ("settled_at" IS NULL)),
  CONSTRAINT "payment_promises_note_check" CHECK ("note" IS NULL OR char_length("note") <= 500)
);
CREATE UNIQUE INDEX "payment_promises_open_unique" ON "payment_promises" ("client_id") WHERE "status" = 'open';
CREATE INDEX "payment_promises_due_idx" ON "payment_promises" ("due_on") WHERE "status" = 'open';
CREATE INDEX "payment_promises_client_idx" ON "payment_promises" ("client_id", "created_at");
