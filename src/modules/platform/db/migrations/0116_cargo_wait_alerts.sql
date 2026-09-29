-- «Olib ketilmagan yuk» (owner, 2026-09-28, answer 3a: «5 va 10 kundan keyin
-- sotuvchi va ofisga ro'yxat, mijozga xabar yo'q»): which waiting episodes the
-- morning sweep has already announced. One row per (client, warehouse, level),
-- level 1 = the warn threshold (5 days), level 2 = the alarm (10).
--
-- The key is the LEVEL and never the day count, so moving a threshold on
-- /admin/settings does not re-announce every client standing in Tashkent.
--
-- A row is re-won — the claim is an UPSERT, automation_fires' shape (0067) —
-- when the waiting set's own clock moved past the last announcement:
-- `sent_at < clock_from`, where the clock is the later of the oldest carton's
-- landing and the client's last pickup at that warehouse. So cargo collected in
-- full and then arriving again is announced again, cartons left behind at a
-- visit are announced again, and a set that simply keeps waiting is announced
-- once per level. Nothing prunes this table: deleting a row re-arms it.
--
-- `client_notices` was deliberately not reused: its drain speaks to the
-- CUSTOMER, and this is a message the customer must never get.
--
-- No screen reads this table (the list is derived from the cargo every time),
-- so a half-applied deploy cannot take a page down with it (#472); only the
-- morning sweep does, and it catches the missing table.
CREATE TABLE cargo_wait_alerts (
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  level integer NOT NULL,
  clock_from timestamptz NOT NULL,
  sent_at timestamptz NOT NULL,
  PRIMARY KEY (client_id, warehouse_id, level),
  CONSTRAINT cargo_wait_alerts_level_check CHECK (level IN (1, 2))
);
