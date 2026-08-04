-- Round 27 (owner): «topshirildidan oldin 'qisman topshirildi' degan joy
-- bo'lsa, o'sha yerda turadi hammasi topshirilgungacha». A sixth cargo state
-- for a stage to follow: the first handover of a split shipment parks the
-- deal at handed_partial, and 'handed' now fires only when EVERY box of the
-- deal's cargo is in the client's hands. Same constraint, one more value.
ALTER TABLE deal_stages DROP CONSTRAINT deal_stages_cargo_trigger_check;
--> statement-breakpoint
ALTER TABLE deal_stages ADD CONSTRAINT deal_stages_cargo_trigger_check
  CHECK (cargo_trigger IS NULL OR cargo_trigger IN ('received', 'departed', 'arrived', 'ready', 'handed_partial', 'handed'));
