import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPRESS_LIB_URL } from '@/components/compress-photo';

/**
 * The photo compressor must not fetch itself from a CDN (round 97).
 *
 * `browser-image-compression` runs in a Web Worker, and the worker it builds
 * does NOT contain the library — it `importScripts` it from
 * `cdn.jsdelivr.net` at runtime, on every single photograph. Measured in this
 * container, which has no route to the public internet: **12.7 s** before that
 * request failed and the library fell back to the main thread. In a Chinese
 * warehouse, where every receipt in this business is created and where
 * jsDelivr is not reliably reachable, the operator adds a photo and the screen
 * simply does nothing — which is exactly what the owner reported.
 *
 * `libURL` points it at our own copy. That copy is only correct while it is
 * the SAME BUILD as the package the bundle imports: a stale file means the
 * worker runs one version of the library and the main thread another, which
 * is the kind of difference that shows up as one corrupted photo in fifty.
 * Nothing else would notice, so this test does.
 */

const ROOT = process.cwd();
const VENDORED = join(ROOT, 'public/vendor/browser-image-compression.js');
const INSTALLED = join(ROOT, 'node_modules/browser-image-compression/dist/browser-image-compression.js');

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('the compressor is served from our own server', () => {
  it('the vendored copy is byte-identical to the installed package', () => {
    // If this fails after a dependency bump, the fix is one command:
    //   cp node_modules/browser-image-compression/dist/browser-image-compression.js \
    //      public/vendor/browser-image-compression.js
    expect(sha(VENDORED)).toBe(sha(INSTALLED));
  });

  it('the URL the worker is given points at that copy, not at a CDN', () => {
    expect(COMPRESS_LIB_URL).toBe('/vendor/browser-image-compression.js');
    expect(COMPRESS_LIB_URL.startsWith('/')).toBe(true);
  });

  it('no screen reaches for the library directly any more', () => {
    // Three screens compressed photos with their own copy of the options, so
    // a fix applied to one of them would have left the other two on the CDN.
    // Source-shape, because all three WORKED — the defect was the default.
    const hits = execSync(
      "grep -rln \"from 'browser-image-compression'\" src/ || true",
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    expect(hits).toEqual(['src/components/compress-photo.ts']);
  });
});
