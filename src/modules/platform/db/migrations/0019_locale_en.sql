-- English joins the interface languages (owner: "for everyone").
-- The locale column is guarded by a CHECK, so the constraint has to be
-- widened before anyone can be switched to it.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_locale_check;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_locale_check
  CHECK (locale IN ('ru', 'uz', 'zh-CN', 'en'));
