#!/bin/sh
# Nightly pg_dump shipped to object storage (spec §15). 30-day retention is
# enforced by bucket lifecycle rules; this script just produces the dump.
set -e
STAMP=$(date +%Y%m%d-%H%M%S)
pg_dump -h postgres -U gsr -d gsr -Fc -f "/backups/gsr-$STAMP.dump"
find /backups -name 'gsr-*.dump' -mtime +30 -delete
