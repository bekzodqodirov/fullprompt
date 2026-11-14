-- The full AI seller, part 2 (spec SPEC-P2-v2 §4.1): the calculation the AI sends to the VED by itself
-- («hisoblatishni o'zi yuboradi»), the VED's answer told to the customer with his markup («VED javobiga ustama
-- qo'shib narx aytadi»), and the lead moved through the funnel by the machine («lid bosqichlarini o'zi
-- o'tkazadi»).
--
-- NOTHING EXISTING GAINS A COLUMN (0138's rule, 0145's, 0148's): `readAgentConfig`, `lockConfig` and
-- `readAutoConfig` are a select() of every declared column, behind probes that answer TRUE one migration
-- behind — a new declared column there would be a 42703 in every reader on deploy morning, the listener's send
-- step among them. The AI seat, the markup, the open-calc cap and the two AI funnel stages live in `settings`
-- rows (a table that always exists); the one new fact that cannot — WHICH offer the machine wrote — is a side
-- table of its own, read behind `agentFullP2Ready()`.
--
-- gsr_ai_reader (0080, allowlist default-deny) is granted NOTHING on the new table (stated): it is a money fact
-- about commission, read by the upsale's own queries only.

-- (1) Two more kinds the layer may open (§1.1, §2.3). `calc` — a reply whose only act is a calculation sent to
-- the VED, judged by its ACTION and never by the model's label; `calc_price` — the VED's answer with his markup,
-- judged by the closed tool that priced it. The CHECK admits both; the STORED row is NOT changed: both boxes ship
-- unticked (his §7 Q1 and Q2 ⭐ — arming has always been his press).
ALTER TABLE "agent_auto_config" DROP CONSTRAINT "agent_auto_config_categories_check";
--> statement-breakpoint
ALTER TABLE "agent_auto_config" ADD CONSTRAINT "agent_auto_config_categories_check" CHECK (
  "categories" <@ ARRAY['greeting', 'qualification', 'faq', 'status', 'price', 'calc', 'calc_price']::text[]
  AND cardinality("categories") >= 1
);
--> statement-breakpoint
-- (2) Commission is never paid to a machine (§2.4a). One row per offer the MACHINE wrote, in the same short
-- transaction as the offer itself — a crash between two separate writes would leave an unmarked machine offer
-- payable (fail open on money, refused). The upsale's payable set excludes a marked offer AFTER its per-request
-- rank, never before it (an older person's offer on the same job must not be promoted to the AI's place).
-- It survives every chat purge with `draft_id` NULL: the offer itself survives, and an offer that lost its mark
-- would become payable.
CREATE TABLE "agent_offers" (
  "offer_id" uuid PRIMARY KEY REFERENCES "calc_offers"("id") ON DELETE CASCADE,
  "request_id" uuid NOT NULL REFERENCES "calc_requests"("id") ON DELETE CASCADE,
  "draft_id" uuid REFERENCES "agent_drafts"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "agent_offers_draft_idx" ON "agent_offers" ("draft_id");
