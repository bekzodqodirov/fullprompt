-- Horgos and Yallama hold the truck (docs/XORGOS-NAVBAT.md, the owner's 1a-5a of 2026-11-08),
-- migration 0140 — after 0139_calc_intake_durable.
-- A truck held in a typed border queue more than a day past the longest wait it was given is
-- told to the logists ONCE per (truck, post, wait) — his 3a «har bir navbat uchun bir marta».
-- This row IS that once: claimed in the same transaction as the message rows and never deleted
-- by the app. `entered_at` is the entry the warning was about: time alone never re-arms it, but
-- a LATER entry — the logist pressed «Chegarada» after phoning the driver, so the wait counts
-- again from the press — is a new wait, and its overrun is told too (the design's judge: the one
-- warning must not be spent on a wait the press replaced). No CHECK on `post`: the list of posts
-- lives in one place, `BORDER_POSTS` (tracking/map-data.ts), as on `border_queue` (0118).
-- gsr_ai_reader (0080, allowlist default-deny) is granted nothing here.
CREATE TABLE "truck_queue_alerts" (
  "batch_id" uuid NOT NULL REFERENCES "batches"("id") ON DELETE CASCADE,
  "post" text NOT NULL,
  "entered_at" timestamptz NOT NULL,
  "alerted_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "truck_queue_alerts_pk" PRIMARY KEY ("batch_id", "post")
);
