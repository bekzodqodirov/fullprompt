-- The calls dedup key was (device, phone, started_at) — and a device is a
-- PAIRING, not a phone: revoke + re-pair mints a new device id, the app
-- re-reads its register from the install-day floor, and every call of that
-- day landed a second time under the new id. Production showed it on day
-- one (four rows for two calls). The fact is the PERSON's call: one user,
-- one number, one start instant — whichever pairing reported it.

-- Existing duplicates first: keep one row per (user, phone, started_at) —
-- a row carrying audio beats one without, then the earliest write wins.
DELETE FROM call_logs WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY user_id, phone, started_at
      ORDER BY (attachment_id IS NOT NULL) DESC, created_at ASC, id ASC
    ) AS rn
    FROM call_logs
  ) ranked
  WHERE rn > 1
);

ALTER TABLE call_logs DROP CONSTRAINT call_logs_dedup;
ALTER TABLE call_logs ADD CONSTRAINT call_logs_dedup UNIQUE (user_id, phone, started_at);
