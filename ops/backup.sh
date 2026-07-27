#!/bin/sh
# A second, independent local dump: this container needs only postgres, so it
# keeps working on a night when the app is down. The app's own nightly job
# takes the copy that goes OFF this machine (Google Drive) — see
# src/modules/platform/jobs/backup.ts and docs/BACKUP.md.
#
# --no-owner so the dump restores onto any postgres, not only one that already
# has the `gsr` role. Without it a restore on a laptop or a new provider —
# exactly the situation a backup exists for — throws on every object.
set -e
STAMP=$(date +%Y%m%d-%H%M%S)
pg_dump -h postgres -U gsr -d gsr -Fc --no-owner -f "/backups/gsr-$STAMP.dump"
find /backups -name 'gsr-*.dump' -mtime +30 -delete
