-- VED module, phase C (docs/VED.md): the selling price book, and the offer.
--
-- Two tables and no new column on `calc_request_items` — that absence is the
-- design's main decision. The price book is keyed on the **TNVED CODE**, not
-- on a normalised product name, and that choice answers four problems at once:
--
--   * a name key can never match. The spec says «product/category» and the
--     owner's example is the bare word «monitor», while the warehouse types
--     «Монитор 27 дюйм». A code covers both.
--   * a code is CONFIRMED BY A PERSON. Phase B refuses to seal a group whose
--     rates nobody confirmed, so by the time a price exists its code has been
--     looked at.
--   * SQL cannot reproduce `productKey()`. Measured on realistic names, five
--     of six differ: `btrim()` strips U+0020 only and postgres's `\s` does not
--     match NBSP, U+FEFF or U+202F, while JavaScript's `trim()` and `\s` do.
--     A backfilled key that silently differs joins nothing, for ever.
--   * `calc_request_items` has TWO writers — `openCalcRequest` and
--     `recalcFromSealed`, whose copy carries its own explicit column list. A
--     new column there would be NULL on every corrected and re-quoted
--     request: exactly the freshest prices missing from a price history.

-- (1) Dictionary 4 — the SELLING price book.
--
--     What we charge a client, per cube or per kilo, versioned by date like
--     the other three. It is NOT the sealed VED price: that one is the FLOOR
--     the seller's price sits above (the owner's law 4), and a book filled
--     from it would be a book of floors labelled as prices.
CREATE TABLE IF NOT EXISTS calc_price_book (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tnved_code text NOT NULL,
  /** What the owner reads. «Monitorlar», not «8528520000». */
  label text NOT NULL,
  price_usd numeric(14,4) NOT NULL,
  unit text NOT NULL DEFAULT 'm3',
  effective_date date NOT NULL,
  note text,
  entered_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calc_price_book_unit_check CHECK (unit IN ('m3', 'kg')),
  -- NaN is a real `numeric` in postgres and answers TRUE to `>= 0`; `<> 'NaN'`
  -- is the only comparison that excludes it (#777).
  CONSTRAINT calc_price_book_value_check CHECK (
    price_usd > 0 AND price_usd <> 'NaN'::numeric
  )
);
--> statement-breakpoint
-- Corrected twice in one day is one correction: the last word that day wins.
CREATE UNIQUE INDEX IF NOT EXISTS calc_price_book_code_date_unique
  ON calc_price_book (tnved_code, effective_date);
--> statement-breakpoint

-- (2) What was actually OFFERED to a client, and for how much.
--
--     A sealed version is what the calculation cost. This is what the seller
--     told the customer — a different number by design, and the one the price
--     book learns from. It is also the record that answers «what did we quote
--     this client last time», which no table could answer before.
CREATE TABLE IF NOT EXISTS calc_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES calc_versions(id) ON DELETE CASCADE,
  /** Denormalised so an offer can be found by card without walking two joins. */
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  client_price_usd numeric(14,2) NOT NULL,
  /** TRUE when the seller quoted BELOW the sealed floor. Phase D locks it. */
  below_floor boolean NOT NULL DEFAULT false,
  locale text NOT NULL,
  /** Exactly what was sent, so «what did we tell them» is answerable. */
  text text NOT NULL,
  offered_by uuid NOT NULL REFERENCES users(id),
  offered_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calc_offers_entity_check CHECK (entity_type IN ('deal', 'lead')),
  CONSTRAINT calc_offers_locale_check CHECK (locale IN ('uz', 'ru', 'en')),
  CONSTRAINT calc_offers_price_check CHECK (
    client_price_usd > 0 AND client_price_usd <> 'NaN'::numeric
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS calc_offers_version_idx ON calc_offers (version_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS calc_offers_entity_idx ON calc_offers (entity_type, entity_id, offered_at);
--> statement-breakpoint

-- (3) The history screen reads sealed versions by the codes inside them, so
--     the codes have to be reachable without opening every breakdown jsonb.
CREATE INDEX IF NOT EXISTS calc_groups_code_idx ON calc_groups (tnved_code)
  WHERE tnved_code IS NOT NULL;
