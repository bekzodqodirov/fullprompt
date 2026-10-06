-- Two rounds of 2026-10-06 share this file (docs/TELEGRAM-TOPSHIRIQ.md §8,
-- docs/VED-TARIX.md §9), written once by the lead before either was built.
--
-- 1. Where a task came from. Until now a task did not say: the seller's calc
--    job, the VED's hand-back, a payment promise's call and an automation
--    rule all carry a `created_by` and read as given by hand — so «📤 Men
--    bergan» would have been mostly machine work, and the calc job would have
--    received «⏰ Muddatni surish» on a deadline the calc queue owns. NULL
--    means «before 0124, unknown» and reads as a hand-given task; every writer
--    from here on names its origin (a REQUIRED option of `createTask`).
--    `bound_id` is the record whose clock the task carries — the calc request
--    or the payment promise. No FK: either table may delete its row, and a
--    task is history.
ALTER TABLE "tasks" ADD COLUMN "origin" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "bound_id" uuid;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_origin_check"
  CHECK ("origin" IS NULL OR "origin" IN ('hand', 'calc', 'calc_return', 'promise', 'automation'));
--> statement-breakpoint
-- `origin IS NOT NULL` is spelled out: with a NULL origin the IN is NULL, and
-- a CHECK passes on NULL — a bound record with no origin would slip through.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_bound_check"
  CHECK ("bound_id" IS NULL OR ("origin" IS NOT NULL AND "origin" IN ('calc', 'promise')));
--> statement-breakpoint
-- The assignee's «👀 Qabul qildim», and the author's «🔔 Eslatish» clock
-- (at most one reminder per task per half hour, by a CAS on this column).
ALTER TABLE "tasks" ADD COLUMN "accepted_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "reminded_at" timestamptz;
--> statement-breakpoint
-- The author's own Telegram messages the task was given with (a voice note,
-- a photo, a forwarded customer message): {chatId, messageId} pointers, so a
-- reassign can forward them to the new person too.
ALTER TABLE "tasks" ADD COLUMN "source_messages" jsonb;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_messages_check"
  CHECK ("source_messages" IS NULL OR jsonb_typeof("source_messages") = 'array');
--> statement-breakpoint
-- «📤 Men bergan» reads a person's open given tasks; there was no index on
-- the author at all.
CREATE INDEX "tasks_author_idx" ON "tasks" ("created_by", "status");
--> statement-breakpoint
-- The backfill. Pointers first — exact, and they carry the bound record:
UPDATE "tasks" SET "origin" = 'calc', "bound_id" = r."id"
  FROM "calc_requests" r WHERE r."task_id" = "tasks"."id";
--> statement-breakpoint
UPDATE "tasks" SET "origin" = 'promise', "bound_id" = p."id"
  FROM "payment_promises" p WHERE p."task_id" = "tasks"."id" AND "tasks"."origin" IS NULL;
--> statement-breakpoint
-- …then the fixed titles the code itself writes, for the machine tasks no
-- pointer reaches: the open «Hisoblash: …» a release left behind (the dead
-- cancel fixed the same day) and the VED's hand-backs. No `bound_id`: there is
-- nothing left to point at, and a calc task without one carries no button.
-- The calc rule is the WHOLE machine shape — `Hisoblash: <label> (<n>)`,
-- priority 1, timed, on a lead or a deal — because a person may type a title
-- that starts «Hisoblash: » too, and labelling their task 'calc' would take
-- its buttons away. The emoji prefixes below only ever come from the code.
UPDATE "tasks" SET "origin" = 'calc'
  WHERE "origin" IS NULL AND "title" ~ '^Hisoblash: .* \(\d+\)$'
    AND "priority" = 1 AND "all_day" = false AND "entity_type" IN ('lead', 'deal');
--> statement-breakpoint
UPDATE "tasks" SET "origin" = 'calc_return'
  WHERE "origin" IS NULL AND "title" LIKE '↩️ Ma''lumot to''ldiring: %';
--> statement-breakpoint
UPDATE "tasks" SET "origin" = 'promise'
  WHERE "origin" IS NULL AND "title" LIKE '💵 To‘lov va’dasi%';
--> statement-breakpoint
-- 2. The VED's own note on a «Готово» answer (his 9a): how the figure was
--    reached, for the VED and leadership only. `answer_note` cannot be it —
--    that one is pushed to the seller in Telegram and printed on the card.
--    VALID and never NOT VALID: `rekeyLeadCalcRequests` re-UPDATEs every
--    closed request of a won lead in one statement whose failure is only
--    logged, so a check old rows could fail would silently stop every seal
--    and offer following a won lead (#778/#789). Every existing row is NULL.
ALTER TABLE "calc_requests" ADD COLUMN "answer_internal_note" text;
--> statement-breakpoint
ALTER TABLE "calc_requests" ADD CONSTRAINT "calc_requests_internal_note_check"
  CHECK ("answer_internal_note" IS NULL OR "answer_internal_note" ~ '\S');
--> statement-breakpoint
-- The history's answer rows (his 8a), newest first.
CREATE INDEX "calc_requests_answer_idx" ON "calc_requests" ("completed_at" DESC)
  WHERE "completed_via" = 'task' AND "answer_amount" IS NOT NULL;
