-- The photographs finally leave the machine (owner: «rasimlar va hamma back
-- up google drivega back olamiz»).
--
-- Until now the only thing copied off the VPS was the database dump, and even
-- that never ran — see 0081's round in DECISIONS. The cargo photographs, the
-- call recordings, the Telegram media and every attached document lived in
-- one MinIO volume on one disk, with no second copy anywhere. Losing the
-- machine lost every photograph of every carton this company has received.
--
-- This is the LEDGER that makes that copy incremental: an object is uploaded
-- once and never again, and «once» has to survive a restart, so it is a row
-- rather than a listing of the destination. The primary key carries the
-- DESTINATION as well as the key, so pointing the backup at a different
-- place correctly reads as «nothing is there yet» instead of «all done».
--
-- Nothing here is ever deleted when an attachment is: a backup that follows
-- deletions is not a backup. The row outliving the file is the point.

CREATE TABLE backup_objects (
  storage_key text NOT NULL,
  destination text NOT NULL,
  -- What the DESTINATION said it stored, not what we sent — the same rule the
  -- dump upload has always followed.
  size_bytes bigint NOT NULL,
  -- The file id at the destination (Drive) or the object key (S3), so a
  -- restore does not have to search for it by name.
  remote_ref text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (storage_key, destination)
);

-- The nightly question is «what is still missing», asked as an anti-join from
-- attachments in created_at order; this index is the side it lands on.
CREATE INDEX backup_objects_dest_idx ON backup_objects (destination, storage_key);
