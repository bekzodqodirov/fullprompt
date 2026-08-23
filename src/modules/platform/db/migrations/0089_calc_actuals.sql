-- VED phase E1 — the join between a calculation and the cargo it priced,
-- and what stood on the screen when a person pressed ✅ (docs/VED.md phase E).
--
-- The comparison itself is stored NOWHERE. `voidCostEntry` deletes
-- allocations and a late FX rate re-prices an entry, so a figure frozen the
-- night the truck landed becomes the lie the screen repeats for ever;
-- `calcActuals()` is one grouped query at read time. What IS stored here is
-- only what can never be recomputed later: which prixod belongs to which
-- calculation, and what a person was looking at when they confirmed.

-- ---------------------------------------------------------------------------
-- The join, at the RECEIPT grain.
--
-- Not on `deals`, which is the grain the design first reached for and the one
-- that cannot work: a deal carries many prixods and many calculations, and
-- 0085 deliberately DROPPED «one open request per card» because a client
-- legitimately runs several jobs at once. Not on `calc_requests` either — one
-- calculation is regularly answered by two or three trucks' worth of cargo.
-- Many receipts -> one request is the shape the business actually has.
-- ---------------------------------------------------------------------------
ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS calc_request_id uuid REFERENCES calc_requests(id) ON DELETE SET NULL,
  -- 'auto' is a SUGGESTION and never scores anybody. `dealFor` sends every
  -- repeat client to their newest OPEN deal and no seeded stage carries a
  -- cargo trigger, so one open deal alive for months is the normal shape —
  -- a door that stamped «this deal has one sealed calculation» would hang a
  -- whole quarter's prixods on one April quote and report +1200 % against
  -- the person who priced it correctly.
  ADD COLUMN IF NOT EXISTS calc_link_source text,
  ADD COLUMN IF NOT EXISTS calc_link_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS calc_link_confirmed_by uuid REFERENCES users(id);

ALTER TABLE receipts
  ADD CONSTRAINT receipts_calc_link_source_check
  CHECK (calc_link_source IS NULL OR calc_link_source IN ('auto', 'person'));

-- THERE IS DELIBERATELY NO CONSTRAINT TYING THE CONFIRMATION TO THE LINK,
-- and it took two measurements to get here.
--
-- The design asked for a biconditional between `calc_request_id` and
-- `calc_link_source`. That was refused after measuring it: `ON DELETE SET
-- NULL` is an internal `UPDATE ONLY receipts SET calc_request_id = NULL`
-- which touches the FK column ALONE, so the constraint fails 23514 on that
-- internal update and every delete of a calc_request aborts. Six integration
-- files delete calc_requests in cleanup and all six would silently start
-- leaving rows behind (#183).
--
-- The replacement written first — «confirmed_at IS NULL OR request_id IS NOT
-- NULL» — has the SAME shape and was caught by its own test the first time it
-- ran: the delete nulls the pointer, the stamp stays, the CHECK fails, the
-- DELETE aborts. Any constraint spanning the FK column and a sibling does.
--
-- So the state «confirmed, but the calculation was deleted» is legal, and it
-- costs nothing: every reader asks for BOTH columns (`measurableLinkSql`),
-- so an orphaned stamp scores nothing and shows nothing. The alternative was
-- a trigger, which is a lot of machinery to forbid a harmless row.

CREATE INDEX IF NOT EXISTS receipts_calc_request_idx
  ON receipts (calc_request_id) WHERE calc_request_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- What stood on the screen when ✅ was pressed.
--
-- Law 1's missing half. `ai_duty_pct` has been written since 0086 and read by
-- nothing; `ai_proposal` keeps the model's own words as their own value, so
-- «did the VED actually change anything» is answerable a year later instead
-- of being inferred from a diff nobody kept. `confirmed_warnings` is the list
-- the person confirmed OVER — the owner's «ko'rmasdan tasdiqlagan» question
-- cannot be answered by re-deriving today's warnings, because the
-- dictionaries will have moved.
-- ---------------------------------------------------------------------------
ALTER TABLE calc_groups
  ADD COLUMN IF NOT EXISTS ai_proposal jsonb,
  ADD COLUMN IF NOT EXISTS confirmed_warnings jsonb,
  ADD COLUMN IF NOT EXISTS confirm_via text;

ALTER TABLE calc_groups
  ADD CONSTRAINT calc_groups_confirm_via_check
  CHECK (confirm_via IS NULL OR confirm_via IN ('single', 'bulk'));

-- A ✅ must not outlive the numbers it was about, and there are TWO writers
-- that clear it: `unconfirm()` and the clear `setGroupRates` INLINES in its
-- own UPDATE. Both must null these fields or this CHECK raises 23514 on the
-- two most-pressed buttons in the workspace.
ALTER TABLE calc_groups
  ADD CONSTRAINT calc_groups_confirm_pair_check
  CHECK (confirm_via IS NULL OR confirmed_at IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Counters carried to the seal, so the owner's list survives the version.
--
-- A sealed version is immutable and its `breakdown` is a snapshot; these are
-- the three questions phase E asks that a snapshot cannot answer after the
-- dictionaries move underneath it. Integers, so #762's `<> 'NaN'::numeric`
-- has nothing to protect — there is no money column in this migration at all,
-- and that absence is the design: the comparison is COMPUTED.
-- ---------------------------------------------------------------------------
ALTER TABLE calc_versions
  ADD COLUMN IF NOT EXISTS warned_groups        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_blind_groups      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_rate_taken_groups integer NOT NULL DEFAULT 0;

ALTER TABLE calc_versions
  ADD CONSTRAINT calc_versions_e_counts_check
  CHECK (warned_groups >= 0 AND ai_blind_groups >= 0 AND ai_rate_taken_groups >= 0);

-- ---------------------------------------------------------------------------
-- Backfill: 'auto' only, never confirmed, and only where the deal has exactly
-- ONE sealed request that nobody has superseded. Zero rows on the owner's
-- server — phases A-E have never deployed, so `calc_versions` is empty there
-- — it exists so the local and CI fixtures start measurable rather than
-- needing a hand-written link each.
-- ---------------------------------------------------------------------------
UPDATE receipts r
   SET calc_request_id = q.id,
       calc_link_source = 'auto'
  FROM (
    SELECT cr.entity_id AS deal_id, cr.id
      FROM calc_requests cr
      JOIN calc_versions v ON v.request_id = cr.id
     WHERE cr.entity_type = 'deal'
       AND NOT EXISTS (
             SELECT 1 FROM calc_requests s WHERE s.supersedes_request_id = cr.id
           )
     GROUP BY cr.entity_id, cr.id
  ) q
 WHERE r.deal_id = q.deal_id
   AND r.calc_request_id IS NULL
   AND (
     SELECT count(*) FROM calc_requests c2
      JOIN calc_versions v2 ON v2.request_id = c2.id
     WHERE c2.entity_id = r.deal_id AND c2.entity_type = 'deal'
   ) = 1;
