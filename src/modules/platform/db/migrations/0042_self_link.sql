-- A client may now link the cabinet by sharing their own Telegram-verified
-- number (owner, item 13) — no staff-minted code, therefore no staff actor.
-- created_by becomes the honest NULL for self-service links; every existing
-- row keeps its author.
ALTER TABLE client_telegram_links ALTER COLUMN created_by DROP NOT NULL;
