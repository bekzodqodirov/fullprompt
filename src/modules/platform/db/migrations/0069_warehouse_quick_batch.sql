-- Quick loading, per warehouse (round 89).
--
-- A "quick batch" is a truck with NO PLAN: no agent verdict, no approved line
-- list, nothing for the customs paperwork to be built from. That is the right
-- tool for an ad-hoc internal move and the wrong one at a warehouse whose
-- trucks cross a border, which is why the owner asked for it to be taken away
-- from Kashgar specifically — «qashqardagi skladchidan tezkor yuklashni olib
-- tashla».
--
-- Per WAREHOUSE and not per role: the roles are shared across the whole
-- company, so unticking a permission for the Kashgar operator would take
-- quick loading away from Yiwu too. It also cannot ride on
-- `batches.depart_close`, which is the same grant that lets a warehouse
-- DEPART and CLOSE a truck — removing that would stop the work it is meant
-- to allow. `warehouses.issues_to_clients` is the precedent this follows.
--
-- Additive and DEFAULT TRUE, so every warehouse keeps exactly what it has
-- today until somebody unticks the box on the warehouse screen.
ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS allows_quick_batch boolean NOT NULL DEFAULT true;
