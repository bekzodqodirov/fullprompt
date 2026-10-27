-- Har so'rovga yangi bitim (the owner, 2026-10-27: «hozir CRMdan bitimga yutildi deb otkazganda bitim bor deb
-- qaytaryabti agar klient code boyicha clientga biriktirmohchi bolsa … crmdan bitimga yutildi deb otkizadgan
-- bolsak ham yangi bitim ochilishi kerak»; «Boshqa sotuvchining mijozi bo'lsa, jo'natganning CRM'ida yangi lid
-- ochiladi»; docs/UCH-BAND.md §2-§3).
--
-- 1. A client code may carry MANY leads. 0021's partial unique index made a lead the client's one pre-history,
--    so a repeat customer's second enquiry could never be won onto his code («Bu kodda lid allaqachon bor»).
--    The index is replaced by a plain partial one (the card's «lids of this client» reads and the won-lead
--    readers still look leads up by client). ONE-WAY: once any code holds two leads the unique index can never
--    be recreated, so going below 0136 is not offered (docs/UPDATE.md).
DROP INDEX IF EXISTS "leads_client_unique";
CREATE INDEX "leads_client_idx" ON "leads" ("client_id") WHERE "client_id" IS NOT NULL;

-- 2. lead_about_client: which client a lead is ABOUT when it is not the client's own — a request a seller sends
--    for a COLLEAGUE's client lands as a lead in the sender's funnel (6.8 b). The lead stays UNBOUND
--    (`client_id` NULL): bound, it would leave the sender's call list and open-lead count, which read «not yet
--    converted» as `client_id IS NULL`. A SIDE table and never a column on leads (#1381: ~75 whole-row reads
--    would answer 42703 one migration behind). Both FKs CASCADE: the row says nothing once either end is gone,
--    and the test suites delete fixture clients and leads (#1407's reason).
--    gsr_ai_reader (0080, allowlist default-deny) is granted NOTHING on it (stated).
CREATE TABLE "lead_about_client" (
  "lead_id" uuid PRIMARY KEY REFERENCES "leads"("id") ON DELETE CASCADE,
  "client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
-- «The sender's open lead about this client» — the bot's join (a second request for the same client) reads it.
CREATE INDEX "lead_about_client_client_idx" ON "lead_about_client" ("client_id");
