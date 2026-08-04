#!/usr/bin/env bash
# Downloads the self-hosted OSM basemap for the tracking map (/map).
# Run ONCE on the server (repo root):  bash ops/fetch-basemap.sh
# Result: .data/basemap/corridor.pmtiles (~30-80 MB). Without it the map
# page shows the built-in schematic drawing instead.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p .data/basemap

# Corridor bounding box: Uzbekistan ↔ Kyrgyzstan ↔ all of China.
BBOX="55,17,127,49"
MAXZOOM="${BASEMAP_MAXZOOM:-8}"

echo "== 1/3 pmtiles CLI"
if ! command -v ./.data/basemap/pmtiles >/dev/null 2>&1; then
  curl -sL -o /tmp/pmtiles.tar.gz \
    https://github.com/protomaps/go-pmtiles/releases/download/v1.22.1/go-pmtiles_1.22.1_Linux_x86_64.tar.gz
  tar xzf /tmp/pmtiles.tar.gz -C .data/basemap pmtiles
fi

echo "== 2/3 latest world build"
BUILD=$(curl -s https://build.protomaps.com/builds.json | grep -o '"key":"[0-9]*\.pmtiles"' | tail -1 | cut -d'"' -f4)
if [ -z "$BUILD" ]; then
  echo "Could not resolve the latest build — check https://maps.protomaps.com/builds"
  exit 1
fi
echo "   using $BUILD"

echo "== 3/3 extracting corridor (bbox=$BBOX, maxzoom=$MAXZOOM) — a few minutes"
./.data/basemap/pmtiles extract "https://build.protomaps.com/$BUILD" \
  .data/basemap/corridor.pmtiles --bbox="$BBOX" --maxzoom="$MAXZOOM"

ls -lh .data/basemap/corridor.pmtiles
echo "Done. Restart the app (docker compose up -d app) and open /map."
