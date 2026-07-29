-- Phase 7: automation rules — «when X happens, do Y», defined on a form
-- (the visual node editor is cut by plan). One row per rule; the action's
-- shape varies by type, so its config is jsonb validated by zod on write
-- AND on read (the custom-fields options/rules precedent). Stage ids are
-- deliberately un-FK'd: a rule may point at a lead stage or a deal stage
-- depending on trigger_type, and a deleted stage must disable the rule,
-- not block the stage's deletion.
CREATE TABLE IF NOT EXISTS automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  trigger_type text NOT NULL,
  trigger_stage_id uuid,
  trigger_event text,
  action_type text NOT NULL,
  action_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL REFERENCES users(id),
  fire_count integer NOT NULL DEFAULT 0,
  last_fired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_rules_trigger_check
    CHECK (trigger_type IN ('lead_stage', 'deal_stage', 'event')),
  CONSTRAINT automation_rules_trigger_target_check
    CHECK (
      (trigger_type IN ('lead_stage', 'deal_stage') AND trigger_stage_id IS NOT NULL)
      OR (trigger_type = 'event' AND trigger_event IS NOT NULL)
    ),
  CONSTRAINT automation_rules_action_check
    CHECK (action_type IN ('create_task', 'notify'))
);

CREATE INDEX IF NOT EXISTS automation_rules_trigger_idx
  ON automation_rules (trigger_type, active);
