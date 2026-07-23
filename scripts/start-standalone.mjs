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

// server.js chdir()s into .next/standalone — keep local file storage where
// the dev/seed data lives.
process.env.STORAGE_LOCAL_DIR ??= path.resolve('.data/files');

await import(pathToFileURL(path.resolve('.next/standalone/server.js')).href);
