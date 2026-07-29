-- Round 28 (owner): «hisoblash degan zadacha kerak, VED xodimlarim qanchada
-- hisoblab berayotganini bilishim kerak». A calculation REQUEST: who asked,
-- which VED person got it, how big the job is (item_count drives the
-- deadline: 30 min per line, capped at 2 hours), and the two timestamps the
-- speed report is made of. The clock stops when the calculation is actually
-- SAVED (deal lines) or the task is closed — completed_via says which.
CREATE TABLE calc_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  assignee_id uuid NOT NULL REFERENCES users(id),
  item_count integer NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  completed_at timestamptz,
  completed_by uuid REFERENCES users(id),
  completed_via text,
  overdue_notified_at timestamptz,
  CONSTRAINT calc_requests_entity_check CHECK (entity_type IN ('deal', 'lead')),
  CONSTRAINT calc_requests_items_check CHECK (item_count BETWEEN 1 AND 500),
  CONSTRAINT calc_requests_via_check CHECK (completed_via IS NULL OR completed_via IN ('lines', 'task'))
);
--> statement-breakpoint
-- One live request per card: a second «hisoblashga berish» while the first
-- is unanswered is a duplicate, not a new job. The service refuses it first;
-- the index makes the refusal hold against two simultaneous presses.
CREATE UNIQUE INDEX calc_requests_open_entity_idx ON calc_requests (entity_type, entity_id) WHERE completed_at IS NULL;
--> statement-breakpoint
-- The report reads per assignee over a period; the sweep reads open-and-late.
CREATE INDEX calc_requests_assignee_idx ON calc_requests (assignee_id, requested_at);
