-- «Javobsiz qoldi» stops lying (round 88).
--
-- The owner: «habar javobsz qoldi deb warning berishni chatni ichiga kirgandan
-- keyin tohtatish — negaki klient chatga nuqta qoygandur, misol uchun ok yokida
-- got it, shunda bunga sales manager javob bermaydi lekin warning turibti».
--
-- One mark could only ever say two things — the client spoke last, or we did —
-- so a message needing no answer stayed an alarm for ever. Three states now:
-- NEW (nobody has seen it), SEEN (read, no answer needed), answered.
--
-- The signal is deliberately NOT «somebody opened the thread in the CRM».
-- Telegram already knows, because the manager reads these chats on their own
-- phone all day, and it PUSHES that fact to the listener as
-- `UpdateReadHistoryInbox`. Mirroring it means no new habit for anybody — and,
-- more importantly, no new fact about an EMPLOYEE: this is their own Telegram
-- read state, which exists whether we store it or not. A «who opened whose
-- chat, and when» journal would have been a different and much heavier thing
-- to put in front of a supervisor.
--
-- It also fixes the case a CRM-side read marker could not: a supervisor
-- opening a seller's conversation must not silence the SELLER's warning.
-- Here it cannot, because the row follows the account that did the reading.

CREATE TABLE tg_chat_reads (
  -- Whose account read it. Round 20's fence in the key itself: a read is a
  -- fact about one manager's own dialog, never about the conversation.
  manager_user_id uuid NOT NULL REFERENCES users(id),
  peer_id bigint NOT NULL,
  -- Telegram's own id, the same currency `tg_messages.tg_message_id` uses, so
  -- «has this been read» is one comparison and needs no join to our uuids.
  -- Monotonic within a dialog, which is what makes `<=` the right test.
  last_read_tg_message_id bigint NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (manager_user_id, peer_id)
);

-- The reads for one manager's whole screen in one pass — every consumer of
-- this table asks per manager, because that is the only way it may be asked.
CREATE INDEX tg_chat_reads_manager_idx ON tg_chat_reads (manager_user_id);
