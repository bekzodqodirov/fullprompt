-- Driver tracking (owner's flow): at loading, the warehouse worker installs
-- the app on the driver's phone and pairs it with THIS trip. Android streams
-- real positions; iPhone/HarmonyOS stay on the logist's manual updates and
-- the schedule estimate. Everything is trip-scoped, so tracking ends by
-- itself when the batch is delivered.
CREATE TABLE "driver_devices" (
  "id" uuid PRIMARY KEY,
  "batch_id" uuid NOT NULL REFERENCES "batches"("id"),
  "platform" text NOT NULL DEFAULT 'android',
  "label" text,
  -- Short code the warehouse worker types into the app; cleared on pairing.
  "pair_code" text UNIQUE,
  "token_hash" text UNIQUE,
  "paired_at" timestamptz,
  "last_seen_at" timestamptz,
  "revoked_at" timestamptz,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "driver_devices_platform_check" CHECK ("platform" IN ('android', 'other'))
);
CREATE INDEX "driver_devices_batch_idx" ON "driver_devices" ("batch_id");

CREATE TABLE "driver_positions" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "batch_id" uuid NOT NULL REFERENCES "batches"("id"),
  "device_id" uuid REFERENCES "driver_devices"("id"),
  "lat" numeric(9, 6) NOT NULL,
  "lon" numeric(9, 6) NOT NULL,
  "accuracy_m" integer,
  "speed_kmh" numeric(6, 2),
  "recorded_at" timestamptz NOT NULL,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "source" text NOT NULL DEFAULT 'device',
  "created_by" uuid REFERENCES "users"("id"),
  CONSTRAINT "driver_positions_source_check" CHECK ("source" IN ('device', 'manual')),
  CONSTRAINT "driver_positions_lat_check" CHECK ("lat" BETWEEN -90 AND 90),
  CONSTRAINT "driver_positions_lon_check" CHECK ("lon" BETWEEN -180 AND 180)
);
CREATE INDEX "driver_positions_batch_idx" ON "driver_positions" ("batch_id", "recorded_at" DESC);
-- The phone re-sends its offline queue after a reconnect; the same fix must
-- not land twice.
CREATE UNIQUE INDEX "driver_positions_device_time_unique"
  ON "driver_positions" ("device_id", "recorded_at")
  WHERE "device_id" IS NOT NULL;
