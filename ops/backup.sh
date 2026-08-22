#!/bin/sh
# A second, independent local dump: this container needs only postgres, so it
# keeps working on a night when the app is down. It is also the one that
# actually runs — the app image carries no postgres client, so the app's own
# nightly job adopts THIS file and ships it off-site (see backup/run.ts).
#
# --no-owner so the dump restores onto any postgres, not only one that already
# has the `gsr` role. Without it a restore on a laptop or a new provider —
# exactly the situation a backup exists for — throws on every object.
set -e
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="/backups/gsr-$STAMP.dump"

pg_dump -h postgres -U gsr -d gsr -Fc --no-owner -f "$OUT"

# A dump that "succeeded" and wrote nothing is the worst possible outcome: the
# file has the right name and the right date, the prune below then deletes the
# last good one thirty days later, and nobody finds out until a restore. 4096
# bytes is far below any real dump of this database and far above an empty
# custom-format header.
SIZE=$(wc -c < "$OUT")
if [ "$SIZE" -lt 4096 ]; then
  echo "backup.sh: dump is only $SIZE bytes — removing it and keeping the old ones" >&2
  rm -f "$OUT"
  exit 1
fi

# PRUNE ONLY AFTER A GOOD DUMP, which is why it is below the check and not
# beside it. `set -e` plus the exit above means a bad night deletes nothing.
find /backups -name 'gsr-*.dump' -mtime +30 -delete
echo "backup.sh: $OUT ($SIZE bytes)"
