/**
 * Start the production standalone server the same way Docker does.
 * `next start` is NOT supported with `output: 'standalone'` — it can serve a
 * broken React client manifest for route-group pages (the CI failure mode) —
 * so e2e and local prod runs must go through this instead.
 */
import 'dotenv/config';
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Static assets and runtime-read files are not part of the standalone trace.
cpSync('.next/static', '.next/standalone/.next/static', { recursive: true });
for (const extra of ['public', 'src/assets']) {
  if (existsSync(extra)) cpSync(extra, path.join('.next/standalone', extra), { recursive: true });
}

// server.js chdir()s into .next/standalone — resolve local file storage to an
// absolute path FIRST (a relative value from .env would silently point into
// the standalone dir and 404 every previously stored file).
process.env.STORAGE_LOCAL_DIR = path.resolve(process.env.STORAGE_LOCAL_DIR ?? '.data/files');
// Same trap for the map basemap: pin it to the repo's .data before chdir.
process.env.BASEMAP_PATH = path.resolve(
  process.env.BASEMAP_PATH ?? '.data/basemap/corridor.pmtiles',
);

// Self-heal: photos uploaded while the old bug was live landed inside
// .next/standalone/.data — merge them back (never overwrites existing files).
await import('./heal-storage.mjs');

await import(pathToFileURL(path.resolve('.next/standalone/server.js')).href);
