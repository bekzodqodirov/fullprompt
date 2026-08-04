-- Phase 2.2: Telegram client cabinet (owner's spec 3.1/3.2): a client links
-- to the SAME bot via a one-time code minted by staff, then sees cargo
-- status, photos and debt. One chat may represent several clients (broker).
CREATE TABLE "client_telegram_links" (
  "id" uuid PRIMARY KEY,
  "client_id" uuid NOT NULL REFERENCES "clients"("id"),
  "telegram_chat_id" bigint,
  "link_code" text UNIQUE,
  "status" text NOT NULL DEFAULT 'pending',
  "linked_at" timestamptz,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "client_telegram_links_status_check" CHECK ("status" IN ('pending', 'linked', 'revoked'))
);
CREATE INDEX "client_telegram_links_client_idx" ON "client_telegram_links" ("client_id");
CREATE INDEX "client_telegram_links_chat_idx" ON "client_telegram_links" ("telegram_chat_id");
