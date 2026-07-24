-- Per-user Telegram mute settings (spec §11: "Per-user mute settings").
-- A jsonb array of event type names; the special value 'all' mutes every
-- Telegram send. The in-app bell always mirrors everything.
ALTER TABLE "users" ADD COLUMN "muted_notification_types" jsonb NOT NULL DEFAULT '[]'::jsonb;
