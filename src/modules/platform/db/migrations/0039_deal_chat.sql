-- The deal gets its own internal chat (owner: "CRM va BITIM uchun chatlar
-- bo'lishi kerak ichki hodimlar bilan").
--
-- Notes already live in crm_activities for leads and clients; a deal-scoped
-- note is the same thing with a third entity type, not a new table. Widening
-- a CHECK constraint is purely additive: every existing row still satisfies
-- it, nothing is rewritten, and the live database is untouched beyond the
-- constraint definition itself.
ALTER TABLE crm_activities DROP CONSTRAINT IF EXISTS crm_activities_entity_check;
ALTER TABLE crm_activities ADD CONSTRAINT crm_activities_entity_check
  CHECK (entity_type IN ('lead', 'client', 'deal'));
