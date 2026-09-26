-- «Partiya foydasi» reads only the trucks a person marked as a partiya (the
-- owner, 2026-09-26: «faqat tashqi reyslar yani admin yokida bugalter
-- belgilab qoysin partiyada partiya deb»). Which truck is the one the money
-- is analysed on is a business decision, not a property of its two ends —
-- a CN→UZ truck can be a leg and a UZ→UZ one a delivery — so it is a column
-- a person sets. DEFAULT false with no backfill, his answer: «belgisiz qoy
-- men ozim tuzataman».
ALTER TABLE "batches" ADD COLUMN "profit_tracked" boolean NOT NULL DEFAULT false;
