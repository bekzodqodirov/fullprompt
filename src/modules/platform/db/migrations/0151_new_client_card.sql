-- «Yangi mijozga manzil xabari» (the owner, 2026-11-19: «klient code ochilganda sklad adresi zametkada bor … code
-- berganda shu adreslar va botga ssilka qoshilib berilsin telegramga kelsin sotuvchilar shuni ozini pereslat
-- qilishsin», then «xozir zametkada xtoy sklad deb zametkaga qoyilgan 3 adress va rasim»): a COMPANY zametka he
-- ticks is sent, with the code's marking line and the bot link under it, to the seller of every new client code —
-- one message the seller forwards to the customer. He keeps writing the addresses where he already keeps them; the
-- tick is the only new fact.
--
-- SQL-ONLY this release (the house rule, #1313/#1381): `staff_notes` is read whole-row by the 📌 library, the
-- screen and the attachment gate, so declaring the column on the drizzle table would make every one of them throw
-- 42703 on a half-applied deploy (the app new, this migration not yet run). One raw writer (`setNewClientFlag`),
-- one reader (`newClientNotes`), both in notes/service.ts; a later release declares it.
--
-- Only a COMPANY note may carry the tick: a person's own note is invisible to the seller the card goes to, and the
-- card would then carry words no colleague can read on /zametkalar. Moving a ticked note into somebody's own list
-- clears the tick in the same statement (`setNoteShared`), so this CHECK is a fence and never a refusal a person
-- meets. No backfill: nothing is ticked until he ticks it (his own answer — never guessed from a title).
ALTER TABLE "staff_notes" ADD COLUMN "for_new_client" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "staff_notes" ADD CONSTRAINT "staff_notes_new_client_company_check" CHECK (
  NOT "for_new_client" OR "user_id" IS NULL
);
