-- Round 36 (staff bot, owner's item 5): "a client is waiting and nobody has
-- answered". The threshold crossing is remembered ON the message, so one
-- silence is reported ONCE — a reminder that repeats every sweep is a
-- reminder people mute, and then the one that mattered is muted with it.
-- Additive and nullable: every existing row means "never reported", which is
-- the truth, and history is not re-litigated by the first sweep.
ALTER TABLE tg_messages ADD COLUMN reminded_at timestamptz;

-- The sweep asks for incoming messages nobody has been reminded about; a
-- partial index keeps it off the answered mass, which is most of the table.
CREATE INDEX tg_messages_unanswered_idx
  ON tg_messages (client_id, manager_user_id, sent_at DESC)
  WHERE direction = 'in' AND reminded_at IS NULL;
