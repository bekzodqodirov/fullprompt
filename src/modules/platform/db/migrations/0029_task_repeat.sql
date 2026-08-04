-- Recurring tasks (owner: "ha" to "takrorlanuvchi vazifa kerakmi").
--
-- The rule lives ON the task rather than in a separate schedule table, and the
-- next occurrence is created when the current one is CLOSED. That gives the
-- property a small company actually wants: exactly one open instance at a
-- time. A materialising scheduler would put four unfinished copies of "check
-- the till every Monday" on somebody's screen after a month of holiday, which
-- is how a recurring task turns into noise people filter out.
--
-- Cancelling is therefore how a series ENDS — completing carries it on,
-- cancelling stops it. No extra button, and the meaning matches the words.

ALTER TABLE tasks ADD COLUMN repeat_unit text;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN repeat_every integer NOT NULL DEFAULT 1;
--> statement-breakpoint
-- Every occurrence of one rule shares this, so a series can be counted and
-- reported on even though its instances are separate rows.
ALTER TABLE tasks ADD COLUMN series_id uuid;
--> statement-breakpoint
ALTER TABLE tasks ADD CONSTRAINT tasks_repeat_check CHECK (
  repeat_unit IS NULL OR repeat_unit IN ('day', 'week', 'month')
);
--> statement-breakpoint
ALTER TABLE tasks ADD CONSTRAINT tasks_repeat_every_check CHECK (
  repeat_every BETWEEN 1 AND 365
);
--> statement-breakpoint
-- A rule with no deadline has nothing to repeat FROM: "every week" starting
-- when? The form refuses it too; this stops anything else creating one.
ALTER TABLE tasks ADD CONSTRAINT tasks_repeat_needs_due CHECK (
  repeat_unit IS NULL OR due_at IS NOT NULL
);
--> statement-breakpoint
CREATE INDEX tasks_series_idx ON tasks (series_id) WHERE series_id IS NOT NULL;
