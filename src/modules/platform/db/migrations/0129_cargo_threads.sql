-- 0129 cargo threads (the owner's E6 c warehouse half, E7 b, Q4 a — 2026-10-07): a prixod card and a
-- truck card carry a staff thread, read by the office and the staff of the warehouse where the cargo
-- STANDS now. A thread is that card's notes (crm_activities, entity_type = 'receipt' | 'batch'), so the
-- 0127 machinery — the raw writer, the Telegram pair, thread_reads, the dock — applies unchanged. Two
-- CHECK widenings and nothing else; every existing row satisfies both (0039's precedent). A release
-- whose app runs ahead of this file meets a 23514 on exactly these two names, which the app reads as
-- «the server is behind» (thread.ts WIDENED_THREAD_CHECKS), never a white page.
ALTER TABLE "crm_activities" DROP CONSTRAINT IF EXISTS "crm_activities_entity_check";
--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_entity_check"
  CHECK ("entity_type" IN ('lead', 'client', 'deal', 'receipt', 'batch'));
--> statement-breakpoint
ALTER TABLE "thread_reads" DROP CONSTRAINT IF EXISTS "thread_reads_kind_check";
--> statement-breakpoint
ALTER TABLE "thread_reads" ADD CONSTRAINT "thread_reads_kind_check"
  CHECK ("thread_kind" IN ('lead', 'deal', 'client', 'calc', 'receipt', 'batch'));
