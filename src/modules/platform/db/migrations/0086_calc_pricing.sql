-- VED module, phase B (docs/VED.md): the workspace that replaces the Excel.
--
-- Three dictionaries the company has never had (a product's customs baza, a
-- code's rates, the owner's freight tariff), the GROUPS a calculation is made
-- of, and the SEAL — an immutable, versioned, priced document.
--
-- Two shapes are borrowed rather than invented. The dictionaries are
-- `fx_rates` + `rateFor` («latest effective_date ≤ the date»), which is what
-- «edits keep history — an old calc reads its own tariff» is asking for. The
-- seal is `load_plan_versions`: immutable snapshots, a `current_version_no`
-- pointer on the parent, and a UNIQUE (parent, version_no).
--
-- The one place this file departs from `fx_rates` is deliberate and is
-- written into the readers, not the schema: there is **no earliest-row
-- fallback**. fx_rates chose that because a cost entered before the first
-- rate still has to convert; here a missing baza means «nobody has ever
-- priced this product», and inventing a number for it is the whole class of
-- defect this module exists to remove.

-- (1) A product's customs valuation, versioned by the date it took effect.
--
--     Keyed on `product_key` — the SAME `productKey()` normaliser the TNVED
--     memory uses — or the two dictionaries would disagree about what a
--     product IS. `basis` says what the number is per: a unit or a kilogram.
--     One TNVED code holds several products with different bazas (the owner's
--     own words), which is why this is keyed on the product and the RATES
--     below are keyed on the code.
CREATE TABLE IF NOT EXISTS calc_bazas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_key text NOT NULL,
  label text NOT NULL,
  tnved_code text,
  baza_usd numeric(14,4) NOT NULL,
  basis text NOT NULL,
  effective_date date NOT NULL,
  note text,
  entered_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calc_bazas_basis_check CHECK (basis IN ('unit', 'kg')),
  CONSTRAINT calc_bazas_value_check CHECK (baza_usd > 0 AND baza_usd <> 'NaN'::numeric)
);
--> statement-breakpoint
-- The same product corrected twice in one day is one correction: the last
-- word that day wins, which is what a correction means.
CREATE UNIQUE INDEX IF NOT EXISTS calc_bazas_key_date_unique
  ON calc_bazas (product_key, effective_date);
--> statement-breakpoint

-- (2) A TNVED code's rates, versioned the same way and LEARNED from
--     corrections — but only when a person says so: `source` tells a taught
--     rate from a typed one, and the workspace's «write it to the dictionary»
--     box is off by default. A rate learned silently from every seal would
--     learn a one-off lgota-driven number.
CREATE TABLE IF NOT EXISTS calc_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tnved_code text NOT NULL,
  duty_pct numeric(6,3) NOT NULL DEFAULT 0,
  vat_pct numeric(6,3) NOT NULL DEFAULT 0,
  fee_usd numeric(12,2) NOT NULL DEFAULT 0,
  effective_date date NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  note text,
  entered_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calc_rates_source_check CHECK (source IN ('manual', 'correction')),
  CONSTRAINT calc_rates_pct_check CHECK (
    duty_pct BETWEEN 0 AND 100 AND duty_pct <> 'NaN'::numeric
    AND vat_pct BETWEEN 0 AND 100 AND vat_pct <> 'NaN'::numeric
    AND fee_usd >= 0 AND fee_usd <> 'NaN'::numeric
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS calc_rates_code_date_unique
  ON calc_rates (tnved_code, effective_date);
--> statement-breakpoint

-- (3) The owner's own freight table (docs/VED.md §«The freight tariff»).
--
--     A band carries BOTH its bounds, and `max_density` is why. Written as
--     lower bounds alone — «this density and up, until the next row» — the
--     table silently answers EVERY density, including the ones a person left
--     out. The owner's first table left 900-999 kg/m³ out and listed 700
--     twice, and each is money: 30 m³ at 950 kg/m³ is $9,600 or $15,675
--     depending on which way the gap is read. He has since closed both (the
--     seeded table is contiguous — see `wms/calc/tariff-seed.ts`), but the
--     lookup still REFUSES a density no row covers and one that two rows
--     cover, because this table is edited on /admin/tarif and the next hole
--     must be a visible refusal rather than a quietly cheaper invoice.
--
--     `max_density` NULL is the open-ended top row (≥1000, priced per kg).
CREATE TABLE IF NOT EXISTS calc_freight_tariffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone text NOT NULL,
  min_density numeric(10,2) NOT NULL,
  max_density numeric(10,2),
  price_usd numeric(10,4) NOT NULL,
  per_kg boolean NOT NULL DEFAULT false,
  effective_date date NOT NULL,
  entered_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calc_freight_price_check CHECK (price_usd > 0 AND price_usd <> 'NaN'::numeric),
  CONSTRAINT calc_freight_density_check CHECK (
    min_density >= 0 AND (max_density IS NULL OR max_density >= min_density)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS calc_freight_zone_band_date_unique
  ON calc_freight_tariffs (zone, min_density, effective_date);
--> statement-breakpoint

-- (4) The groups a calculation is made of.
--
--     A group carries what is genuinely per-CODE: the code, its rates and the
--     lgota decided for THIS calculation. What it does NOT carry is the
--     baza — that is per product and lives on the items below, because one
--     code holds several products and pricing a whole group at one product's
--     baza is ±45 % on a realistic pair.
--
--     `*_source` is the fence that keeps law 1 true: the legal values are
--     'dictionary' and 'typed'. There is no 'ai', so a model's estimate has
--     nowhere to land — it is recorded in `ai_duty_pct` for the record and
--     read by nothing.
CREATE TABLE IF NOT EXISTS calc_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES calc_requests(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  label text NOT NULL,
  tnved_code text,
  duty_pct numeric(6,3),
  vat_pct numeric(6,3),
  fee_usd numeric(12,2),
  rate_source text,
  duty_free boolean NOT NULL DEFAULT false,
  vat_free boolean NOT NULL DEFAULT false,
  ai_proposed boolean NOT NULL DEFAULT false,
  ai_confidence text,
  /** The model's ESTIMATE. Recorded, never multiplied. */
  ai_duty_pct numeric(6,3),
  confirmed_by uuid REFERENCES users(id),
  confirmed_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calc_groups_rate_source_check CHECK (rate_source IS NULL OR rate_source IN ('dictionary', 'typed')),
  -- NaN is a real `numeric` value in postgres, it survives every range check
  -- a person writes in JavaScript, and `'NaN'::numeric >= 0` answers TRUE —
  -- so a mistyped rate would otherwise reach a sealed, client-facing price.
  -- `<> 'NaN'` is the only comparison that excludes it.
  CONSTRAINT calc_groups_rates_check CHECK (
    (duty_pct IS NULL OR (duty_pct BETWEEN 0 AND 100 AND duty_pct <> 'NaN'::numeric))
    AND (vat_pct IS NULL OR (vat_pct BETWEEN 0 AND 100 AND vat_pct <> 'NaN'::numeric))
    AND (fee_usd IS NULL OR (fee_usd >= 0 AND fee_usd <> 'NaN'::numeric))
  ),
  CONSTRAINT calc_groups_confidence_check CHECK (ai_confidence IS NULL OR ai_confidence IN ('high', 'medium', 'low'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS calc_groups_seq_unique ON calc_groups (request_id, seq);
--> statement-breakpoint

-- (5) The item is the PRICED unit. Its baza is its own product's.
ALTER TABLE calc_request_items ADD COLUMN IF NOT EXISTS group_id uuid
  REFERENCES calc_groups(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE calc_request_items ADD COLUMN IF NOT EXISTS baza_usd numeric(14,4);
--> statement-breakpoint
ALTER TABLE calc_request_items ADD COLUMN IF NOT EXISTS baza_basis text;
--> statement-breakpoint
ALTER TABLE calc_request_items ADD COLUMN IF NOT EXISTS baza_source text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_items_baza_basis_check'
                   AND conrelid = 'calc_request_items'::regclass) THEN
    ALTER TABLE calc_request_items ADD CONSTRAINT calc_items_baza_basis_check
      CHECK (baza_basis IS NULL OR baza_basis IN ('unit', 'kg'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_items_baza_value_check'
                   AND conrelid = 'calc_request_items'::regclass) THEN
    ALTER TABLE calc_request_items ADD CONSTRAINT calc_items_baza_value_check
      CHECK (baza_usd IS NULL OR (baza_usd > 0 AND baza_usd <> 'NaN'::numeric));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calc_items_baza_source_check'
                   AND conrelid = 'calc_request_items'::regclass) THEN
    ALTER TABLE calc_request_items ADD CONSTRAINT calc_items_baza_source_check
      CHECK (baza_source IS NULL OR baza_source IN ('dictionary', 'typed'));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS calc_request_items_group_idx ON calc_request_items (group_id);
--> statement-breakpoint

-- (6) The extras — CCT and whatever else this job needs. They point at the
--     EXISTING cost-type dictionary (`cct` and `freight` have been seeded
--     since round 29), so phase E's calc-vs-actual compares like with like.
CREATE TABLE IF NOT EXISTS calc_extras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES calc_requests(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  cost_type_id uuid REFERENCES cost_types(id),
  label text NOT NULL,
  amount_usd numeric(14,2) NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calc_extras_amount_check CHECK (amount_usd >= 0 AND amount_usd <> 'NaN'::numeric)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS calc_extras_seq_unique ON calc_extras (request_id, seq);
--> statement-breakpoint

-- (7) THE SEAL. Immutable: a row here is never updated after it is written.
--
--     It carries the freight row's IDENTITY rather than an FK alone, because
--     the tariff will be edited and an old calc must go on reading its own
--     numbers. `breakdown` is the whole snapshot — every group with its
--     rates, every item with its baza, every extra — so phase E can compare a
--     year-old quote against what the truck actually cost.
--
--     Two different concessions, two different columns: a BAND OVERRIDE is
--     «this load really belongs in that band» (the VED's judgement about the
--     cargo, flagged), a DISCOUNT is a price concession to this client
--     (flagged, and the column phase D reads to withdraw the upsale right).
CREATE TABLE IF NOT EXISTS calc_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES calc_requests(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  sealed_at timestamptz NOT NULL DEFAULT now(),
  sealed_by uuid NOT NULL REFERENCES users(id),
  valid_until timestamptz NOT NULL,
  section text NOT NULL,
  weight_kg numeric(12,3),
  volume_m3 numeric(12,4),
  density numeric(12,4),
  customs_usd numeric(14,2) NOT NULL DEFAULT 0,
  freight_usd numeric(14,2) NOT NULL DEFAULT 0,
  extras_usd numeric(14,2) NOT NULL DEFAULT 0,
  total_usd numeric(14,2) NOT NULL,
  per_m3_usd numeric(14,2),
  per_kg_usd numeric(14,4),
  freight_zone text,
  freight_band_min numeric(10,2),
  freight_rate numeric(10,4),
  freight_per_kg boolean,
  freight_list_usd numeric(14,2),
  band_override_min numeric(10,2),
  band_override_reason text,
  discount_usd numeric(14,2) NOT NULL DEFAULT 0,
  discount_reason text,
  /** How much of this was still the model's when it was sealed (phase E). */
  ai_groups_sealed integer NOT NULL DEFAULT 0,
  low_confidence_sealed integer NOT NULL DEFAULT 0,
  breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT calc_versions_section_check CHECK (section IN ('yolkira', 'rastamojka', 'podklyuch')),
  -- The last gate before a number becomes what the client was told.
  CONSTRAINT calc_versions_total_check CHECK (total_usd >= 0 AND total_usd <> 'NaN'::numeric),
  CONSTRAINT calc_versions_discount_check CHECK (
    discount_usd >= 0 AND discount_usd <> 'NaN'::numeric
  ),
  CONSTRAINT calc_versions_parts_check CHECK (
    customs_usd <> 'NaN'::numeric AND freight_usd <> 'NaN'::numeric
    AND extras_usd <> 'NaN'::numeric
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS calc_versions_request_no_unique
  ON calc_versions (request_id, version_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS calc_versions_sealed_idx ON calc_versions (sealed_at);
--> statement-breakpoint

-- (8) The parent's pointer, and the chain a correction makes.
--
--     A correction is a NEW request seeded from the sealed one, never a
--     re-opening: clearing `completed_at` would re-arm the overdue sweep, the
--     clock and the manual «Bajarildi» against a request that already has a
--     locked price behind it. It is also exactly what an EXPIRED quote needs,
--     so there is one path and not two.
ALTER TABLE calc_requests ADD COLUMN IF NOT EXISTS current_version_no integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE calc_requests ADD COLUMN IF NOT EXISTS supersedes_request_id uuid
  REFERENCES calc_requests(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE calc_requests ADD COLUMN IF NOT EXISTS freight_zone text;
--> statement-breakpoint
-- The proposal claims its own request, so two people pressing «AI taklif
-- qilsin» do not both spend a model call on the same goods.
ALTER TABLE calc_requests ADD COLUMN IF NOT EXISTS ai_proposal_started_at timestamptz;
--> statement-breakpoint
-- 'sealed' joins the endings 0085 declared.
ALTER TABLE calc_requests DROP CONSTRAINT IF EXISTS calc_requests_via_check;
--> statement-breakpoint
ALTER TABLE calc_requests ADD CONSTRAINT calc_requests_via_check
  CHECK (completed_via IS NULL OR completed_via IN ('lines', 'task', 'returned', 'sealed'));
