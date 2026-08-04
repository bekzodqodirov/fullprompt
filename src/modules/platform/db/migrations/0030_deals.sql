-- Bitim (deal) — one client's job, from "please price this" to "paid".
-- Built to the specification agreed with the owner in docs/DEALS.md.
--
-- The pain this exists for is NOT "there is no record of a job". It is the gap
-- between the price QUOTED and the cargo that actually turned up, and the fact
-- that nobody sees the gap until the client is arguing about it in Tashkent.
-- So a deal carries both sides — the quote and the reality — and the reality
-- side is not typed in by anybody: it is summed from the receipts.
--
-- Purely additive. `expected_arrivals`, `leads`, `client_transactions` and the
-- lead board all keep working exactly as they do today; a deal supersedes the
-- expected-arrival row only for cargo that was actually quoted, and the simple
-- promise stays for cargo that was not (DEALS.md "Dependencies").

-- The deal board's columns. A table rather than a CHECK for the same reason
-- lead_stages is one: the owner reshapes his own pipeline, and a stage he
-- cannot rename is a stage he works around in his head.
CREATE TABLE deal_stages (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  /* 'won' and 'lost' are terminal; everything else is work in progress. The
     board needs to know which columns mean "stop counting this as open". */
  kind text NOT NULL DEFAULT 'open',
  /* A fixed palette, not free-form hex: Tailwind only compiles classes it can
     literally see, so an arbitrary colour would simply not render. */
  color text NOT NULL DEFAULT 'gray',
  sort_order integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deal_stages_kind_check CHECK (kind IN ('open', 'won', 'lost')),
  CONSTRAINT deal_stages_color_check
    CHECK (color IN ('gray', 'blue', 'green', 'amber', 'red', 'purple', 'teal'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX deal_stages_name_unique ON deal_stages (lower(name));
--> statement-breakpoint

CREATE TABLE deals (
  id uuid PRIMARY KEY,
  /* `B-000123` — the number staff will say out loud on the phone. */
  code text NOT NULL UNIQUE,
  client_id uuid NOT NULL REFERENCES clients(id),
  stage_id uuid NOT NULL REFERENCES deal_stages(id),
  /* Who is carrying it RIGHT NOW. Ownership changes hands mid-job here —
     sometimes one salesperson end to end, sometimes a different person per
     stage (DEALS.md "What a deal is") — so this is a current value with an
     audit trail behind it, not a permanent stamp. */
  owner_id uuid REFERENCES users(id),
  title text,

  -- ---- the QUOTE side: what we told the client -------------------------
  quoted_volume_m3 numeric(12, 3),
  quoted_weight_kg numeric(12, 3),
  quoted_amount numeric(14, 2),
  quoted_currency varchar(3) REFERENCES currencies(code),
  quoted_at timestamptz,
  quoted_by uuid REFERENCES users(id),
  /* Answer 5: the quoting clock starts when the VED manager is GIVEN the task,
     not when the client's message arrives. Set from the task engine so "how
     long do we take to price a job" is measured against the moment the work
     actually started. */
  quote_requested_at timestamptz,

  -- ---- money ------------------------------------------------------------
  /* Answer 3: a client who pays less after damage is a DISCOUNT on the deal,
     not a compensation expense somewhere else — otherwise profit per deal
     stops being the truth. Zero, not null, so the arithmetic never meets a
     null. */
  discount_amount numeric(14, 2) NOT NULL DEFAULT 0,
  discount_reason text,
  discount_by uuid REFERENCES users(id),
  discount_at timestamptz,

  -- ---- deferred payment (answer 4) --------------------------------------
  -- The deferral belongs to the DEAL, never to the client: on a client it
  -- becomes permanent, everyone forgets it, and that is how a debt gate dies.
  -- It carries a reason, an owner and an END, because a deferral without an
  -- end is just an excuse.
  deferral_reason text,
  deferred_by uuid REFERENCES users(id),
  deferred_at timestamptz,
  /* The self-resolving condition: "when every box of this deal has arrived".
     The system already knows how many boxes belong to the deal and how many
     landed, so this expires by itself. */
  defer_until_all_arrived boolean NOT NULL DEFAULT false,
  /* The alternative for cases that are not about missing boxes. */
  defer_until_date date,
  /* Stamped when the deferral resolved, so the history says what happened
     rather than silently reverting to "no deferral". */
  deferral_ended_at timestamptz,

  note text,
  lost_reason text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  /* An amount without its currency is not a price. */
  CONSTRAINT deals_quote_currency_check
    CHECK ((quoted_amount IS NULL) OR (quoted_currency IS NOT NULL)),
  CONSTRAINT deals_discount_check CHECK (discount_amount >= 0),
  /* A discount nobody explained is a number nobody can defend later. */
  CONSTRAINT deals_discount_reason_check
    CHECK ((discount_amount = 0) OR (discount_reason IS NOT NULL)),
  /* A deferral must say why and must have an end — one of the two conditions,
     never neither. */
  CONSTRAINT deals_deferral_check CHECK (
    (deferred_at IS NULL)
    OR (deferral_reason IS NOT NULL
        AND (defer_until_all_arrived OR defer_until_date IS NOT NULL))
  )
);
--> statement-breakpoint
CREATE INDEX deals_client_idx ON deals (client_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX deals_stage_idx ON deals (stage_id);
--> statement-breakpoint
CREATE INDEX deals_owner_idx ON deals (owner_id);
--> statement-breakpoint
-- The debtor sweep asks "which deals are still deferred"; without this it is a
-- scan of every deal the company has ever done.
CREATE INDEX deals_deferred_idx ON deals (deferred_at)
  WHERE deferred_at IS NOT NULL AND deferral_ended_at IS NULL;
--> statement-breakpoint

-- One priced item. Sometimes there is one; often 2-4; sometimes a client sends
-- a file with 50 goods that the VED manager groups by TNVED into ~30 lines.
-- A price may be set per line OR as one total on the deal, so amounts here are
-- nullable and the deal's own `quoted_amount` wins when it is set.
CREATE TABLE deal_lines (
  id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  description text NOT NULL,
  tnved_code text,
  quantity numeric(14, 3),
  unit text,
  quoted_volume_m3 numeric(12, 3),
  quoted_weight_kg numeric(12, 3),
  quoted_amount numeric(14, 2),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX deal_lines_deal_idx ON deal_lines (deal_id, seq);
--> statement-breakpoint

-- Usually one deal -> one receipt, but a shipment splits (half today, half
-- tomorrow), so the relationship is one-to-many and the pointer lives here.
-- Nullable for ever: most cargo in this system arrived before deals existed,
-- and plenty will always arrive without a quote.
ALTER TABLE receipts ADD COLUMN deal_id uuid REFERENCES deals(id);
--> statement-breakpoint
CREATE INDEX receipts_deal_idx ON receipts (deal_id) WHERE deal_id IS NOT NULL;
--> statement-breakpoint

-- Deals join the entity registry (migration 0027), which is what gives them
-- custom fields and tasks for free rather than as two more features to build.
-- Inserted here as well as declared in ENTITY_SPECS: `syncEntityRegistry` only
-- runs from the seed, and a task raised on a deal the morning after a deploy
-- would otherwise hit a foreign key that has not been written yet.
INSERT INTO custom_entities (code, sort_order) VALUES ('deal', 15)
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- The owner's real pipeline. Seeded here rather than in seed.ts because a
-- board with no columns cannot be opened at all, and the seed skips a database
-- that already has data.
INSERT INTO deal_stages (id, name, kind, color, sort_order) VALUES
  (gen_random_uuid(), 'Narx so''raldi',   'open', 'gray',   10),
  (gen_random_uuid(), 'Narx berildi',     'open', 'blue',   20),
  (gen_random_uuid(), 'Yuk kutilmoqda',   'open', 'purple', 30),
  (gen_random_uuid(), 'Skladda',          'open', 'teal',   40),
  (gen_random_uuid(), 'Yo''lda',          'open', 'amber',  50),
  (gen_random_uuid(), 'Yetkazildi',       'open', 'green',  60),
  (gen_random_uuid(), 'To''landi',        'won',  'green',  70),
  (gen_random_uuid(), 'Bekor qilindi',    'lost', 'red',    80)
ON CONFLICT DO NOTHING;
