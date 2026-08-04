-- Round 55: the alarm about a dead driver phone cannot live on the phone.
-- When a paired device on an in-transit batch goes quiet past the map's own
-- staleness threshold, the logists are told ONCE per silence; the stamp on
-- the device row is what makes it once. Cleared by the next position, so a
-- new silence later is reported again.
ALTER TABLE driver_devices ADD COLUMN silent_notified_at timestamptz;
