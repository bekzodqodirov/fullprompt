-- Tracking map (owner's feature): the logist can pin where an in-transit
-- truck actually is ("still at the border") — the map re-anchors its
-- estimate from that moment. One latest pin per batch is enough.
ALTER TABLE "batches" ADD COLUMN "tracking_checkpoint" jsonb;
