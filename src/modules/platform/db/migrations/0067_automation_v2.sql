-- Automation rules at full strength (round 85): time triggers, conditions,
-- and a record of what has already fired.
--
-- Everything here is ADDITIVE. Every rule the owner has written keeps working
-- untouched: `conditions` defaults to an empty list, which matches everything,
-- and `stale_days` is only read by the two new trigger types.

-- «Only if the cargo is more than 5 kub», «only Instagram leads». A LIST of
-- {field, op, value}, ANDed — kept as jsonb rather than columns because the
-- fields a rule may test are per-board and the set will grow; the shape is
-- validated in code, where the per-board field list already lives.
ALTER TABLE automation_rules ADD COLUMN conditions jsonb NOT NULL DEFAULT '[]'::jsonb;

-- How long a card may sit still before the two new triggers fire. Null for
-- every existing rule, and only read by `lead_stale` / `deal_stale`.
ALTER TABLE automation_rules ADD COLUMN stale_days integer;

-- The trigger CHECK widens rather than being dropped: a rule must still name
-- SOMETHING to fire on, and the two new types name a stage exactly like the
-- move-triggered ones do.
ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_trigger_check;
ALTER TABLE automation_rules ADD CONSTRAINT automation_rules_trigger_check
  CHECK (trigger_type IN ('lead_stage', 'deal_stage', 'event', 'lead_stale', 'deal_stale'));

ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_trigger_target_check;
ALTER TABLE automation_rules ADD CONSTRAINT automation_rules_trigger_target_check
  CHECK (
    (trigger_type IN ('lead_stage', 'deal_stage') AND trigger_stage_id IS NOT NULL)
    OR (trigger_type = 'event' AND trigger_event IS NOT NULL)
    -- A time trigger needs both halves: which column, and how long is too long.
    OR (trigger_type IN ('lead_stale', 'deal_stale')
        AND trigger_stage_id IS NOT NULL AND stale_days IS NOT NULL)
  );

-- What a time trigger has already said.
--
-- A move-triggered rule fires on an EVENT, which happens once. A time trigger
-- fires on a CONDITION, which is true every hour until somebody acts — so
-- without this the sweep would open the same task every sweep, for ever, which
-- is how people learn to ignore the thing that was meant to save them. The
-- unique index IS the mechanism, not a check somebody can forget; the sweep
-- inserts first and only acts when the insert wins.
CREATE TABLE automation_fires (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  fired_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX automation_fires_once_idx
  ON automation_fires (rule_id, entity_type, entity_id);

-- The sweep asks «what has this rule already said», so the rule leads.
CREATE INDEX automation_fires_rule_idx ON automation_fires (rule_id, fired_at);
