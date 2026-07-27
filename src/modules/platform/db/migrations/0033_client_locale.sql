-- The client's own language (owner: "rus va ing tili bo'lsa ham yaxshi bo'lar edi").
--
-- NULLABLE and with NO DEFAULT, deliberately. The owner's production database
-- holds his complete, hand-corrected client base and this release must not
-- touch a single existing row: a nullable column with no default is a
-- catalogue-only change in postgres 16 — O(1) whatever the row count, no
-- table rewrite. NULL is also the honest value: it means "nobody has asked
-- this client yet", which is different from "they chose Uzbek".
--
-- Three languages, not the staff four. Nobody's customer here reads the app
-- in Chinese; a Chinese-speaking client falls back in code, not in data.
--
-- The CHECK tolerates NULL on purpose — an unset language is valid.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS locale text;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_locale_check;
ALTER TABLE clients ADD CONSTRAINT clients_locale_check
  CHECK (locale IS NULL OR locale IN ('uz', 'ru', 'en'));
