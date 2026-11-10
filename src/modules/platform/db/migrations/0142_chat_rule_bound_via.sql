-- 0139 — whose binding a chat's lead rule is (the 2026-10-29 review of his «1 a»).
--
-- A hidden number writing to a WORK number is a lead the listener opens by
-- itself (chat-lead `phonelessLeadForChat`), and that binding is nobody's
-- answer: it yields to a person, to the phone book, to a closed lead. The
-- first cut read «nobody's» off the row's SHAPE — include, a lead, no client,
-- no `decided_by` — and round 113's website door (`landSiteTag`) has written
-- exactly that shape since it shipped: it has no actor either. Production
-- holds such rows, so the website's visitors would have been read as the
-- listener's guesses — not stored on a personal number, deleted when the book
-- claimed the phone. No column of the row tells the two apart, and no lead
-- fact can (the machine door reuses ANY open lead of the chat, a website lead
-- included), so the marker is POSITIVE and written by that one door alone:
-- 'work_account', or NULL — which every existing row is, and stays.
--
-- ADDITIVE and deliberately NOT declared on the drizzle table this release
-- (0127's reason, #472): drizzle names every declared column in every INSERT,
-- every bare RETURNING and every whole-row select, and `tg_chat_rules` is read
-- whole-row by the tray, the bot's stranger buttons and the minting door —
-- one migration behind they would all answer 42703. Written by one raw
-- statement, read through to_jsonb(row) (NULL, never 42703, on an old schema).
-- Fenced by tests/unit/chat-rule-bound-via.test.ts.
--
-- gsr_ai_reader (0080, allowlist default-deny) is granted nothing new.
ALTER TABLE "tg_chat_rules" ADD COLUMN IF NOT EXISTS "bound_via" text;
--> statement-breakpoint
ALTER TABLE "tg_chat_rules" DROP CONSTRAINT IF EXISTS "tg_chat_rules_bound_via_check";
--> statement-breakpoint
ALTER TABLE "tg_chat_rules" ADD CONSTRAINT "tg_chat_rules_bound_via_check"
  CHECK ("bound_via" IS NULL OR "bound_via" = 'work_account');
