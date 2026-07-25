import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Self-hosted OSM basemap file (PMTiles). Lives under .data (gitignored,
 * volume-mounted in docker) — downloaded once per server by
 * `ops/fetch-basemap.sh`. Absent file = the map page falls back to the
 * built-in SVG corridor drawing.
 */
export function basemapPath(): string {
  return process.env.BASEMAP_PATH ?? join(process.cwd(), '.data', 'basemap', 'corridor.pmtiles');
}

export function basemapAvailable(): boolean {
  return existsSync(basemapPath());
}
