-- D (the owner, 2026-10-07, «sklad mudiri so'ramasdan beraversin», answers
-- D2-D7): a release on debt carries WHY, in words, mandatory for whoever
-- ticks. A column of its own and not `note`: `handovers.note` prints on the
-- act the receiver signs (often a driver), and a client's debt is not a
-- stranger's business. Written only when the tick was USED over a real debt —
-- a stale tick over nothing stores no reason. No backfill: older releases had
-- none. No index: it is read by the handover's key.
--
-- One-directional pair: a reason implies the tick, never the other way round
-- (every tick written before this release has none, and a stale tick over a
-- cleared debt writes none either). The service is the fence for «a USED tick
-- has a reason»; this CHECK is the fence for «a reason is never blank and
-- never rides a handover nobody ticked».
--
-- gsr_ai_reader already reads `handovers` table-wide (0080): the note is
-- visible to the admin's AI tier like the debt figures beside it (stated).
ALTER TABLE "handovers" ADD COLUMN "debt_note" text;
--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_debt_note_check" CHECK (
  "debt_note" IS NULL OR ("debt_ok" AND btrim("debt_note") <> '' AND char_length("debt_note") <= 500)
);
