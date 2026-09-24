-- «Zavod reysi» (owner, 2026-09-24, B1-B6 and D1): a truck WE hire collects
-- cargo from one to three factories and brings it to our warehouse, where it
-- is received, counted again and labelled as any prixod. Designed, judged by
-- four lenses, redesigned (DECISIONS #1002-): the pickup's lines ARE the
-- promise — `expected_arrivals` is not touched, because six readers of that
-- table would have treated a truck's cargo as a seller's promise.
--
-- Additive only. Nothing existing changes meaning: a receipt with no stop is
-- every receipt there has ever been, and the cost scope widens by one value.

-- The factory directory (B6): who, where, what — so a problem with the goods
-- next month has a phone number. The map point is a SUGGESTION from a
-- geocoder until a person confirms it (`geo_confirmed_at`).
CREATE TABLE factories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address text,
  phone text,
  wechat text,
  goods_note text,
  note text,
  lat numeric(9, 6),
  lon numeric(9, 6),
  geo_source text,
  geo_precision text,
  geo_label text,
  geo_confirmed_at timestamptz,
  geo_confirmed_by uuid REFERENCES users(id),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT factories_lat_check CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  CONSTRAINT factories_lon_check CHECK (lon IS NULL OR lon BETWEEN -180 AND 180),
  CONSTRAINT factories_point_pair_check CHECK ((lat IS NULL) = (lon IS NULL)),
  CONSTRAINT factories_geo_source_check CHECK (geo_source IS NULL OR geo_source IN ('amap', 'osm', 'manual'))
);
--> statement-breakpoint
CREATE INDEX factories_name_idx ON factories (lower(name));
--> statement-breakpoint

-- The truck (B1): the logist who hired it enters it.
CREATE SEQUENCE pickup_code_seq;
--> statement-breakpoint
CREATE TABLE pickups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  dest_warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  vehicle_plate text,
  driver_name text,
  driver_phone text,
  planned_on date,
  status text NOT NULL DEFAULT 'planned',
  started_at timestamptz,
  arrived_at timestamptz,
  cancelled_at timestamptz,
  note text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pickups_status_check CHECK (status IN ('planned', 'on_road', 'arrived', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX pickups_live_idx ON pickups (dest_warehouse_id) WHERE status IN ('planned', 'on_road', 'arrived');
--> statement-breakpoint

-- A factory on the truck's way (B3: sometimes two or three). The road ON from
-- this stop (to the next one, or to the warehouse for the last) is fetched
-- once and stored; `leg_key` names the endpoints it was fetched for, so a
-- moved pin makes it stale instead of silently wrong.
CREATE TABLE pickup_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pickup_id uuid NOT NULL REFERENCES pickups(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  factory_id uuid NOT NULL REFERENCES factories(id),
  collected_at timestamptz,
  collected_by uuid REFERENCES users(id),
  stamp_note text,
  leg_points jsonb,
  leg_hours numeric(8, 2),
  leg_source text,
  leg_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pickup_stops_seq_unique UNIQUE (pickup_id, seq),
  CONSTRAINT pickup_stops_leg_hours_check CHECK (leg_hours IS NULL OR (leg_hours > 0 AND leg_hours <> 'NaN'::numeric)),
  CONSTRAINT pickup_stops_leg_source_check CHECK (leg_source IS NULL OR leg_source IN ('osrm', 'line'))
);
--> statement-breakpoint

-- What the truck collects there, per client (or per marking when nobody has
-- claimed it yet): the factory's count (exact, B2) and the driver's recount.
CREATE TABLE pickup_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stop_id uuid NOT NULL REFERENCES pickup_stops(id) ON DELETE CASCADE,
  client_id uuid REFERENCES clients(id),
  marking text,
  goods text NOT NULL,
  factory_boxes integer NOT NULL,
  driver_boxes integer,
  volume_m3 numeric(12, 4),
  weight_kg numeric(12, 3),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pickup_lines_owner_check CHECK (client_id IS NOT NULL OR (marking IS NOT NULL AND marking <> '')),
  CONSTRAINT pickup_lines_boxes_check CHECK (factory_boxes > 0 AND (driver_boxes IS NULL OR driver_boxes > 0)),
  CONSTRAINT pickup_lines_measure_check CHECK (
    (volume_m3 IS NULL OR (volume_m3 > 0 AND volume_m3 <> 'NaN'::numeric))
    AND (weight_kg IS NULL OR (weight_kg > 0 AND weight_kg <> 'NaN'::numeric))
  )
);
--> statement-breakpoint
CREATE INDEX pickup_lines_stop_idx ON pickup_lines (stop_id);
--> statement-breakpoint

-- Which factory stop a prixod came from — the STOP, so «which factory» is one
-- answer on the receipt card. Written by confirmReceipt through the pickup's
-- own door, and by the attach/detach control; never guessed.
ALTER TABLE receipts ADD COLUMN pickup_stop_id uuid REFERENCES pickup_stops(id);
--> statement-breakpoint
CREATE INDEX receipts_pickup_stop_idx ON receipts (pickup_stop_id) WHERE pickup_stop_id IS NOT NULL;
--> statement-breakpoint

-- The truck's cost (B5a): split over the cargo it brought, by m³.
ALTER TABLE cost_entries ADD COLUMN pickup_id uuid REFERENCES pickups(id);
--> statement-breakpoint
ALTER TABLE cost_entries DROP CONSTRAINT cost_entries_scope_check;
--> statement-breakpoint
ALTER TABLE cost_entries DROP CONSTRAINT cost_entries_scope_target_check;
--> statement-breakpoint
ALTER TABLE cost_entries ADD CONSTRAINT cost_entries_scope_check CHECK (scope IN ('receipt', 'batch', 'crate', 'pickup'));
--> statement-breakpoint
ALTER TABLE cost_entries ADD CONSTRAINT cost_entries_scope_target_check CHECK (
  (scope = 'receipt' AND receipt_id IS NOT NULL)
  OR (scope = 'batch' AND batch_id IS NOT NULL)
  OR (scope = 'crate' AND crate_id IS NOT NULL)
  OR (scope = 'pickup' AND pickup_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX cost_entries_pickup_idx ON cost_entries (pickup_id) WHERE pickup_id IS NOT NULL;
