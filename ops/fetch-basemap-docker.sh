#!/bin/sh
# Runs INSIDE the alpine "basemap" compose service (works on Windows/Mac/Linux
# hosts alike):  docker compose --profile basemap run --rm basemap
set -eu

apk add --no-cache curl >/dev/null

echo "== 1/3 pmtiles CLI"
curl -sL -o /tmp/pmtiles.tar.gz \
  https://github.com/protomaps/go-pmtiles/releases/download/v1.22.1/go-pmtiles_1.22.1_Linux_x86_64.tar.gz
tar xzf /tmp/pmtiles.tar.gz -C /tmp pmtiles

echo "== 2/3 latest world build"
BUILD=$(curl -s https://build.protomaps.com/builds.json | grep -o '"key":"[0-9]*\.pmtiles"' | tail -1 | cut -d'"' -f4)
if [ -z "$BUILD" ]; then
  echo "Could not resolve the latest build — check https://maps.protomaps.com/builds"
  exit 1
fi
echo "   using $BUILD"

echo "== 3/3 extracting corridor (UZ+KG+China, maxzoom 8) — a few minutes"
/tmp/pmtiles extract "https://build.protomaps.com/$BUILD" \
  /out/corridor.pmtiles --bbox=55,17,127,49 --maxzoom=8

ls -lh /out/corridor.pmtiles
echo "Done. The /map page now shows the real map (refresh the browser)."
