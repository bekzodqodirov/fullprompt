-- «reply qaysi habarga bo'ldi» + «forvarded deb accountusername turadi»:
-- a message may quote another one, and may have arrived from somewhere else.
--
-- The quoted message is held as Telegram's OWN id, never as a uuid FK to
-- tg_messages. Two reasons and the second is the one that decides it: a reply
-- can point at a message older than the import window, so an FK would refuse
-- the row and the reply would be lost rather than merely unresolvable; and
-- `purgeExcludedChat` deletes tg_messages while keeping tg_outbox, so an FK
-- would either block the purge or cascade a hole into the queue. It resolves
-- through the (manager, peer, tg_message_id) unique index the thread already
-- has, and an unresolvable quote simply renders as «xabar» rather than
-- breaking the bubble.
ALTER TABLE tg_messages
  ADD COLUMN IF NOT EXISTS reply_to_tg_message_id bigint,
  -- Who the message was forwarded FROM, as Telegram gives it: a name, or
  -- «Yashirin foydalanuvchi» for an account whose forwards are anonymised.
  -- Text and not a peer id, because the source is usually not somebody this
  -- system has ever heard of and the manager only needs to read it.
  ADD COLUMN IF NOT EXISTS fwd_from text;

-- The reply target for a message WE are sending. Same shape, same reason.
ALTER TABLE tg_outbox
  ADD COLUMN IF NOT EXISTS reply_to_tg_message_id bigint;
