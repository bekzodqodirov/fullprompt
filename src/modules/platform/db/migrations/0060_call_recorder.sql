-- Qo'ng'iroq yozuvlari CRM'da (owner: «telefonlarni zapisini yozadigan qilsak
-- ... usha zapis bizni crm lentada korinsa»).
--
-- The recording happens on the PHONE — Android gives no app the call audio,
-- so the phone's own recorder writes the file and our APK ships it. What the
-- server keeps is governed by the owner's two answers:
--   · client_id NOT NULL — a call to a number the client book does not know
--     is never stored (the tg-import rule: hodim's personal calls are not
--     the company's data);
--   · reads are scoped like Telegram (own + supervision), so the columns
--     carry WHO took the call.
--
-- A device is bound to a USER, not a trip: unlike a driver's phone, a
-- seller's phone records for as long as they work here. The token is stored
-- hashed; revocation keeps the hash so the phone can be answered 410 —
-- a 401 is retried for ever (the driver app's lesson).
CREATE TABLE call_recorder_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  label text,
  pair_code text UNIQUE,
  token_hash text UNIQUE,
  platform text NOT NULL DEFAULT 'android',
  paired_at timestamptz,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_recorder_devices_user_idx ON call_recorder_devices (user_id);

CREATE TABLE call_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  device_id uuid NOT NULL REFERENCES call_recorder_devices(id),
  direction text NOT NULL,
  phone text NOT NULL,
  started_at timestamptz NOT NULL,
  duration_sec integer NOT NULL DEFAULT 0,
  -- The audio arrives in a SECOND request (multipart, minutes later when the
  -- recorder has closed the file) — nullable by design, and a call the phone
  -- never recorded stays a call.
  attachment_id uuid REFERENCES attachments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_logs_direction_check CHECK (direction IN ('in', 'out')),
  -- The phone re-sends its recent log on every cycle (that is how a missed
  -- upload heals), so the same call arriving twice must be a no-op.
  CONSTRAINT call_logs_dedup UNIQUE (device_id, phone, started_at)
);
-- The card reads one client's calls newest-first; the scoping reads add user.
CREATE INDEX call_logs_client_idx ON call_logs (client_id, started_at DESC);
CREATE INDEX call_logs_user_idx ON call_logs (user_id, started_at DESC);
