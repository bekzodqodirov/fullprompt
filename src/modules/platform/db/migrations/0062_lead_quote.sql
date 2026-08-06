-- Round 71: the owner's answer to the filter question overrode #108's "no
-- price on a lead" — after the hisoblatish stage the SERVICE price is written
-- on the lead, and that number rides with it into won/lost. Additive and
-- nullable: an unquoted lead is the normal state, and production holds his
-- whole funnel.
ALTER TABLE leads ADD COLUMN quoted_amount numeric(14,2);
ALTER TABLE leads ADD COLUMN quoted_currency varchar(3);
ALTER TABLE leads ADD COLUMN quoted_volume_m3 numeric(12,3);
ALTER TABLE leads ADD COLUMN quoted_weight_kg numeric(12,3);
