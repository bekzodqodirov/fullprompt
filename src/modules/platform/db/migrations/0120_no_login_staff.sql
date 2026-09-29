-- Tizimga kirmaydigan hodim (owner, 2026-09-29, his 2b: «Tizimga kirmaydigan
-- hodimlarga (masalan, Xitoydagilarga) ham oylik qatori kerakmi?» — «b»).
--
-- A person who is PAID here but never signs in is an ordinary `users` row
-- that cannot sign in, because the salary chain is keyed on users.id end to
-- end (recurring_expenses.employee_id, expenses.employee_id, «To'landi»,
-- every employee join) and needs no second person key. «Cannot sign in» is
-- stated, not implied by a sentinel hash: verifyPassword swallows a malformed
-- hash as `false`, which would block the door by accident and say nothing.
--
-- Relaxing, not rewriting (0056's shape): every existing row keeps its hash,
-- its phone and its meaning, and takes TRUE, so the four CHECKs validate on
-- the table as it stands.
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_enabled boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
--> statement-breakpoint
-- The accountant often has no number for a warehouse worker in China, and a
-- shared warehouse phone would collide with UNIQUE (NULLs never do).
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;
--> statement-breakpoint
-- A credential exactly when the row is a login.
ALTER TABLE users ADD CONSTRAINT users_login_password_check
  CHECK (login_enabled = (password_hash IS NOT NULL));
--> statement-breakpoint
-- The login box and the staff bot both identify a login by its phone.
ALTER TABLE users ADD CONSTRAINT users_login_phone_check
  CHECK (NOT login_enabled OR phone IS NOT NULL);
--> statement-breakpoint
-- A username is a login name; a person with no login has none.
ALTER TABLE users ADD CONSTRAINT users_login_username_check
  CHECK (login_enabled OR username IS NULL);
--> statement-breakpoint
-- The third credential column (no writer yet): the first PIN-login round must
-- not inherit a no-login row that can carry one.
ALTER TABLE users ADD CONSTRAINT users_login_pin_check
  CHECK (login_enabled OR quick_pin_hash IS NULL);
