-- Q5 a (the owner, 2026-10-07): «O'rnatish paytida botga yozilgan javoblar — bot qayta yoqilganda qayta
-- ishlansin». The bot stops dropping what Telegram held while it was down, so two things must survive a restart:
-- the one-message waits a person was asked for (telegram_chat_waits), and the record that an effect of one
-- Telegram message or press already happened (telegram_once), because the same update can be delivered twice and
-- the same button tapped many times while nobody answered.
-- Both are pruned: Telegram keeps nothing older than 24 h, so nothing older can be asked again.
-- gsr_ai_reader (0080, allowlist default-deny) is granted NOTHING on either table.
CREATE TABLE "telegram_chat_waits" (
  "chat_id" bigint NOT NULL,
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "armed_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  PRIMARY KEY ("chat_id", "kind"),
  CONSTRAINT "telegram_chat_waits_kind_check" CHECK ("kind" IN ('task', 'staff_entry', 'ad_visit', 'cabinet_link')),
  CONSTRAINT "telegram_chat_waits_window_check" CHECK ("expires_at" > "armed_at"),
  CONSTRAINT "telegram_chat_waits_payload_check" CHECK (jsonb_typeof("payload") = 'object')
);
--> statement-breakpoint
CREATE INDEX "telegram_chat_waits_expires_idx" ON "telegram_chat_waits" ("expires_at");
--> statement-breakpoint
CREATE TABLE "telegram_once" (
  "key" text PRIMARY KEY,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "telegram_once_key_check" CHECK ("key" ~ '^(m|q):[^:]+:[^:]+:[a-z_]+$' AND length("key") <= 200)
);
--> statement-breakpoint
CREATE INDEX "telegram_once_created_idx" ON "telegram_once" ("created_at");
