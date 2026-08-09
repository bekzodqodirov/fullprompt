-- The tray's missing answer (round 82).
--
-- 0064 taught the LISTENER to open a lead by itself on a work number. On a
-- personal number the same stranger becomes a question on «Qaysi chatlar» —
-- and the only answers that screen could give were «this is client X» and
-- «never». There was no way to say the true thing about a person writing in
-- for the first time: «this is business, but they are nobody yet».
--
-- So a rule may now point at a LEAD instead of a client, which is the same
-- widening `tg_messages` itself took in 0064 and `call_logs` took in 0063.
-- The include CHECK moves with it rather than being dropped: an included
-- chat must still name SOMEBODY, or the rule would promise a message a home
-- it does not have. A rule keeps its lead pointer after `convertLead` — the
-- lead row survives conversion, and `rekeyLeadChats` moves the messages onto
-- the minted code without the listener needing to be told anything.
ALTER TABLE tg_chat_rules ADD COLUMN lead_id uuid REFERENCES leads(id);

ALTER TABLE tg_chat_rules DROP CONSTRAINT tg_chat_rules_include_check;
ALTER TABLE tg_chat_rules ADD CONSTRAINT tg_chat_rules_include_check
  CHECK (decision <> 'include' OR client_id IS NOT NULL OR lead_id IS NOT NULL);
