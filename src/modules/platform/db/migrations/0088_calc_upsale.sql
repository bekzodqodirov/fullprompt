-- VED phase D — the upsale, its approval and its payout (docs/VED.md law 4).
--
-- The upsale itself is NOT stored, and that is the round's first decision.
-- It is `client_price_usd - calc_versions.total_usd`, and BOTH parents are
-- immutable: a version is never updated after it is written (0086), and a
-- correction is a NEW request through `supersedes_request_id`; an offer names
-- its own `version_id`, so the floor it was measured against cannot move
-- under it. Writing the difference down could only ever create a way for it
-- to disagree with itself.
--
-- What genuinely cannot be derived is here: whether the promise was ALLOWED,
-- and whether the money has been HANDED OVER. A derived number can be paid
-- twice; that is what `payout_expense_id IS NULL` exists to stop.
--
-- Deliberately NOT granted to `gsr_ai_reader`. 0080's allowlist is
-- default-deny, and `calc_offers` + `calc_versions` together are every margin
-- in the company, so silence is the right answer and needs no statement here.

ALTER TABLE calc_offers
  -- Law 4: below-floor is admin-only. The ROW is always recorded — the flag
  -- is how the owner sees who is discounting, and a door in front of a seller
  -- with a customer on the phone is a door they walk around by not using the
  -- screen (#766). What is locked is the PROMISE: until `approved_at` is
  -- stamped the offer sends no Telegram text, renders no PDF, is not the
  -- card's price and is never payable.
  ADD COLUMN IF NOT EXISTS below_floor_reason text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id),

  -- THE PAYOUT. One expense settles several offers — a seller is paid once a
  -- week, not once per quote — so this is not unique. NULL is the whole
  -- pay-twice fence: the claim's WHERE is `payout_expense_id IS NULL`.
  ADD COLUMN IF NOT EXISTS payout_expense_id uuid REFERENCES expenses(id),
  ADD COLUMN IF NOT EXISTS payout_at timestamptz,
  ADD COLUMN IF NOT EXISTS payout_by uuid REFERENCES users(id),
  -- What the SELLER was credited, in USD, computed server-side from the
  -- offer's own two immutable parents and never typed. The expense carries
  -- what actually left the till, which may be som at the day's rate — round
  -- 39's rule: two amounts, the gap printed, never averaged.
  ADD COLUMN IF NOT EXISTS payout_usd numeric(14,2);
--> statement-breakpoint

-- Phase C's below-floor rows were RELEASED the moment they were written: their
-- text had already gone out. Backfilling the approval keeps that true instead
-- of retroactively suspending a promise a customer is already holding.
-- Production holds none — 0087 has never deployed — so this is for
-- hand-run local databases, and it is why the CHECKs below tolerate an
-- already-approved row.
UPDATE calc_offers
   SET approved_at = offered_at, approved_by = offered_by
 WHERE below_floor AND approved_at IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  -- A reason is nullable but never empty — `discount_reason`'s own shape.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'calc_offers_below_floor_reason_check'
       AND conrelid = 'calc_offers'::regclass
  ) THEN
    ALTER TABLE calc_offers
      ADD CONSTRAINT calc_offers_below_floor_reason_check
      CHECK (below_floor_reason IS NULL OR btrim(below_floor_reason) <> '');
  END IF;

  -- A reason and an approval are facts ABOUT a below-floor price. On an
  -- ordinary offer they would be noise every report has to explain away.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'calc_offers_below_floor_only_check'
       AND conrelid = 'calc_offers'::regclass
  ) THEN
    ALTER TABLE calc_offers
      ADD CONSTRAINT calc_offers_below_floor_only_check
      CHECK (below_floor OR (below_floor_reason IS NULL AND approved_at IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'calc_offers_approval_pair_check'
       AND conrelid = 'calc_offers'::regclass
  ) THEN
    ALTER TABLE calc_offers
      ADD CONSTRAINT calc_offers_approval_pair_check
      CHECK ((approved_at IS NULL) = (approved_by IS NULL));
  END IF;

  -- NaN is a real numeric and answers TRUE to `> 0` (#762). `<> 'NaN'` is the
  -- only comparison postgres has that excludes it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'calc_offers_payout_amount_check'
       AND conrelid = 'calc_offers'::regclass
  ) THEN
    ALTER TABLE calc_offers
      ADD CONSTRAINT calc_offers_payout_amount_check
      CHECK (payout_usd IS NULL OR (payout_usd > 0 AND payout_usd <> 'NaN'::numeric));
  END IF;

  -- 0054's paired idiom: paid is all four columns, or none of them.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'calc_offers_payout_pair_check'
       AND conrelid = 'calc_offers'::regclass
  ) THEN
    ALTER TABLE calc_offers
      ADD CONSTRAINT calc_offers_payout_pair_check
      CHECK (
        (payout_expense_id IS NULL) = (payout_at IS NULL)
        AND (payout_expense_id IS NULL) = (payout_by IS NULL)
        AND (payout_expense_id IS NULL) = (payout_usd IS NULL)
      );
  END IF;
END $$;
--> statement-breakpoint

-- The admin's queue: below-floor prices waiting on a person.
CREATE INDEX IF NOT EXISTS calc_offers_pending_idx
  ON calc_offers (offered_at) WHERE below_floor AND approved_at IS NULL;
--> statement-breakpoint
-- The payout queue's own question: what does this seller have unpaid.
CREATE INDEX IF NOT EXISTS calc_offers_unpaid_idx
  ON calc_offers (offered_by, offered_at) WHERE payout_expense_id IS NULL;
--> statement-breakpoint
-- `voidExpense`'s re-open reads this one (#528's pair rule).
CREATE INDEX IF NOT EXISTS calc_offers_payout_expense_idx
  ON calc_offers (payout_expense_id) WHERE payout_expense_id IS NOT NULL;
--> statement-breakpoint
-- The payable predicate ranks versions per request. Without this it is a scan
-- per report render.
CREATE INDEX IF NOT EXISTS calc_versions_request_no_idx
  ON calc_versions (request_id, version_no DESC);
--> statement-breakpoint
-- «has this request been corrected» — the supersedes chain, read per row.
CREATE INDEX IF NOT EXISTS calc_requests_supersedes_idx
  ON calc_requests (supersedes_request_id) WHERE supersedes_request_id IS NOT NULL;
--> statement-breakpoint
-- «has this deal been invoiced» — round 69 wired `deal_id` up and nothing has
-- ever grouped on it.
CREATE INDEX IF NOT EXISTS client_transactions_deal_live_idx
  ON client_transactions (deal_id) WHERE deal_id IS NOT NULL AND voided_at IS NULL;
