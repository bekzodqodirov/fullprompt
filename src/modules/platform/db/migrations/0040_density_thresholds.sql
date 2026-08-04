-- The owner's density bands (2026-07-28): "150 kg gacha yashil, 250 gacha
-- sariq, 450 gacha och qizil, 450 dan tepasi to'q qizil".
--
-- Only a row still sitting on the OLD default is moved; any other value is
-- his own edit in admin settings and must not be overwritten. A missing row
-- needs nothing — the new default in code answers for it.
UPDATE settings
SET value = '{"light": 150, "medium": 250, "heavy": 450}'::jsonb
WHERE key = 'density_thresholds'
  AND value = '{"light": 200, "medium": 300, "heavy": 400}'::jsonb;
