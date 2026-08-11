-- Taqsimot (round 96): who takes an inbound lead is a PERSON, and an ordered
-- rule list decides which advert stream lands on whom.
--
-- The role column (0066 `roles.inbound_rota`) said «this JOB takes its turn».
-- The owner's correction, the day the first Meta lead landed on the admin:
-- «bizning firmada hamma sotuvchi, lekin hamma lead bilan ishlamaydi» — the
-- queue is made of people, not job titles. Additive: the role column stays
-- (a column holding data is never dropped in the release that stops reading
-- it) but nothing reads it after this.

ALTER TABLE users ADD COLUMN inbound_rota boolean NOT NULL DEFAULT false;

-- Behaviour-preserving backfill: everyone the role flag put in the queue is
-- still in it the morning this deploys. The owner then EDITS the list instead
-- of discovering an empty rotation by way of unowned leads.
UPDATE users SET inbound_rota = true
WHERE active = true AND id IN (
  SELECT ur.user_id FROM user_roles ur
  JOIN roles r ON r.id = ur.role_id
  WHERE r.inbound_rota = true
);

-- One routing rule: «this stream goes to these people». Read top-down by
-- sort_order, first match wins, no match falls back to the general rotation.
-- `user_ids` is a jsonb list (the automation rules' notify action set the
-- precedent) — inside a matched rule the same fewest-first fairness applies.
CREATE TABLE inbound_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sort_order integer NOT NULL DEFAULT 0,
  -- NULL = any source; otherwise one of the code's INBOUND_SOURCE_KEYS.
  source_key text,
  -- NULL = no text condition; otherwise a case-insensitive «contains» over
  -- what the person wrote (name + note).
  keyword text,
  user_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  -- How many leads this rule has assigned — the list's fire_count.
  assigned_count integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inbound_routes_order_idx ON inbound_routes (sort_order, created_at);
