-- Ikki eshik (docs/IKKI-ESHIK.md §0), migration 0140 — after 0139_calc_intake_durable.
-- His 2026-11-08 report: «🧮 Hisoblatish» and «🤖 AI rastamojka» were ONE collector, so the
-- two doors he chose between behaved the same. The door becomes a fact of the REQUEST, read
-- from the row by every later reader (the pass, the ➕ add door, the seeded collection) and
-- never from a job payload: a pg-boss job queued before this migration carries none.
-- Nothing is backfilled. gsr_ai_reader (0080) reads the new column through its table-level
-- grant on `calc_requests` (no secret in it, stated).

-- (1) Which bot door the job came in through. NULL = legacy: every request before this
-- migration, the card form, the thread door and the AI sotuvchi — and NULL means TODAY's
-- behaviour on every reader (§0.2). Only 'plain' silences anything, only 'ai' passes a mute.
-- NOT declared on the drizzle table this release (schema/wms.ts says why): drizzle names
-- every declared column in every INSERT and whole-row select, and those are every calc
-- writer and reader in the app — one migration behind, each would be a 42703 (#472).
ALTER TABLE "calc_requests" ADD COLUMN "intake_door" text;
--> statement-breakpoint
ALTER TABLE "calc_requests" ADD CONSTRAINT "calc_requests_intake_door_check"
  CHECK ("intake_door" IS NULL OR "intake_door" IN ('plain', 'ai'));
--> statement-breakpoint
-- (2) Files sent in a row outside a collection get ONE question (his 6a, §4.1): the burst is
-- durable, a `telegram_chat_waits` row of kind 'burst', so a deploy between two forwards
-- loses nothing. Widened the way 0138 widened it — every existing kind kept.
ALTER TABLE "telegram_chat_waits" DROP CONSTRAINT "telegram_chat_waits_kind_check";
--> statement-breakpoint
ALTER TABLE "telegram_chat_waits" ADD CONSTRAINT "telegram_chat_waits_kind_check" CHECK ("kind" IN (
  'task', 'staff_entry', 'ad_visit', 'cabinet_link', 'agent_edit', 'agent_price', 'agent_code', 'burst'
));
