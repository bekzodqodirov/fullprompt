-- Zametka = nom + matn + fayllar, boshqa hech narsa.
--
-- The owner, the evening 0097 shipped: «nmaga zametkani faqat sklad uchun qb
-- qoygansan — zametkani nomi, tekst (nima narsaligini yozish) va filelar
-- bolishi kerak, kordinat boshqa narsalar kerak emas».
--
-- His first message did say «rasim file text locationlarni», and the
-- coordinate went in on that word — but the four fields together made the
-- screen read as a WAREHOUSE form, which is the opposite of a library
-- everyone keeps their own things in. A note is now three things and no more.
--
-- The columns are dropped rather than left unused: they carry no data (the
-- library ships empty and the feature is one deploy old), and a column that
-- means nothing is a question every later reader has to answer twice.
ALTER TABLE "staff_notes" DROP CONSTRAINT IF EXISTS "staff_notes_geo_check";
--> statement-breakpoint
ALTER TABLE "staff_notes" DROP CONSTRAINT IF EXISTS "staff_notes_place_pair_check";
--> statement-breakpoint
ALTER TABLE "staff_notes" DROP CONSTRAINT IF EXISTS "staff_notes_place_geo_check";
--> statement-breakpoint
ALTER TABLE "staff_notes" DROP COLUMN IF EXISTS "lat";
--> statement-breakpoint
ALTER TABLE "staff_notes" DROP COLUMN IF EXISTS "lon";
--> statement-breakpoint
ALTER TABLE "staff_notes" DROP COLUMN IF EXISTS "place_title";
--> statement-breakpoint
ALTER TABLE "staff_notes" DROP COLUMN IF EXISTS "place_address";
