-- Tasks (owner: "tasklar calendarlar").
--
-- Purely additive: nothing existing is altered. The CRM follow-up
-- (`leads.next_action_at`) keeps working exactly as it does today and the call
-- list at /crm/today is untouched — a task is a different thing (somebody
-- ASSIGNS it to somebody else, it has a due time and it gets closed), and
-- rewriting a mechanism the sales managers use daily to make room for it would
-- be trading a working screen for a new one.
--
-- The entity link reuses `custom_entities` from migration 0027, so a task can
-- hang off any object the registry knows — and the owner's own entities, when
-- they arrive, carry tasks for free.

-- The kinds of work, as an editable list rather than a CHECK constraint.
CREATE TABLE task_types (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  icon text,
  sort_order integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX task_types_name_unique ON task_types (lower(name));
--> statement-breakpoint

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  note text,
  type_id uuid REFERENCES task_types(id),
  assignee_id uuid NOT NULL REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  /* A deadline is optional: "sometime" is a real answer and forcing a date
     makes people type a fake one. */
  due_at timestamptz,
  /* Most deadlines are a DAY, not a moment. Storing the flag beside the
     timestamp keeps "Friday" from rendering as "Friday 00:00" on a calendar. */
  all_day boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'open',
  done_at timestamptz,
  done_by uuid REFERENCES users(id),
  /* What actually happened — the answer, not the question. */
  result text,
  /* What the task is about. Both null = a standalone task. */
  entity_type text REFERENCES custom_entities(code),
  entity_id uuid,
  priority integer NOT NULL DEFAULT 2,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tasks_status_check CHECK (status IN ('open', 'done', 'cancelled')),
  CONSTRAINT tasks_priority_check CHECK (priority BETWEEN 1 AND 3),
  /* A task points at a whole record or at nothing; half a pointer is a bug
     waiting to be rendered as a broken link. */
  CONSTRAINT tasks_entity_check CHECK ((entity_type IS NULL) = (entity_id IS NULL)),
  /* "Done" and "when it was done" cannot disagree. */
  CONSTRAINT tasks_done_check CHECK ((status = 'done') = (done_at IS NOT NULL))
);
--> statement-breakpoint
-- The one query that runs on every page load: my open tasks, soonest first.
CREATE INDEX tasks_assignee_idx ON tasks (assignee_id, status, due_at);
--> statement-breakpoint
-- The panel on a card: what is outstanding on THIS record.
CREATE INDEX tasks_entity_idx ON tasks (entity_type, entity_id);
--> statement-breakpoint
-- The calendar and the overdue sweep read only what is still open.
CREATE INDEX tasks_due_idx ON tasks (due_at) WHERE status = 'open';
--> statement-breakpoint

-- Seeded so the feature is usable on day one; every one of them is editable
-- and can be switched off.
INSERT INTO task_types (id, name, icon, sort_order) VALUES
  ('019f9e00-0000-7000-8000-000000000001', 'Qo''ng''iroq', '📞', 10),
  ('019f9e00-0000-7000-8000-000000000002', 'Uchrashuv', '🤝', 20),
  ('019f9e00-0000-7000-8000-000000000003', 'Hisoblash', '🧮', 30),
  ('019f9e00-0000-7000-8000-000000000004', 'Hujjat', '📄', 40),
  ('019f9e00-0000-7000-8000-000000000005', 'To''lov', '💰', 50),
  ('019f9e00-0000-7000-8000-000000000006', 'Boshqa', '📝', 100);
